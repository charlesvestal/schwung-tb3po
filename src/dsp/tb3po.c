/* TB-3PO DSP — generative 303-style acid-bassline sequencer.
 * Ported from the Phazerville Hemisphere Suite TB_3PO.h applet.
 * Original © djphazer and contributors, GPL-3.0.
 *
 * Runs as an overtake generator plugin (plugin_api_v2). The render_block
 * callback is the tick — called every audio block (~2.9 ms), giving us
 * sample-accurate sequencing. render_block itself outputs silence; MIDI
 * is emitted via host->midi_send_internal / midi_send_external. */

#include "include/plugin_api_v1.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <pthread.h>
#include <unistd.h>

#define SAMPLE_RATE 44100
#define MAX_STEPS   32
#define NUM_BANKS   8

/* Binary state file. Path is fixed — tb3po is a single-instance tool. */
#define TB3PO_STATE_DIR  "/data/UserData/schwung/tool_state"
#define TB3PO_STATE_PATH TB3PO_STATE_DIR "/tb3po.bin"
#define TB3PO_STATE_MAGIC 0x50334254u   /* "TB3P" little-endian */
#define TB3PO_STATE_VERSION 1u

typedef enum { STEP_REST = 0, STEP_NOTE = 1, STEP_ACCENT = 2, STEP_SLIDE = 3 } step_kind_t;

/* Scale degrees in semitones from root. */
typedef struct { const char *name; int degrees[12]; int len; } scale_t;

static const scale_t SCALES[] = {
    { "Minor",     {0, 2, 3, 5, 7, 8, 10},         7 },
    { "Phrygian",  {0, 1, 3, 5, 7, 8, 10},         7 },
    { "HarmMinor", {0, 2, 3, 5, 7, 8, 11},         7 },
    { "MinPent",   {0, 3, 5, 7, 10, 0, 0},         5 },
    { "Dorian",    {0, 2, 3, 5, 7, 9, 10},         7 },
    { "Major",     {0, 2, 4, 5, 7, 9, 11},         7 }
};
#define NUM_SCALES ((int)(sizeof(SCALES) / sizeof(SCALES[0])))

typedef struct tb3po_inst {
    const host_api_v1_t *host;

    /* Host transport tracking (polled from render_block a few times a second). */
    int poll_counter;
    float host_bpm;
    int host_clock_status;
    int prev_clock_status;
    int follow_transport;   /* 1 = start/stop with Move's transport; 0 = free run */

    /* MIDI-clock pulse sync: when the shim delivers 0xF8 pulses, we advance on
     * every 6th pulse for sample-accurate 16ths, completely bypassing the
     * internal sample-accumulator. Falls back to internal if no pulses arrive. */
    int pulse_sync_active;
    long pulses_since_block;    /* pulses seen since start of this render_block */
    long blocks_since_last_pulse;

    /* PRNG — xorshift32 */
    uint32_t rng;

    /* Pattern */
    uint8_t steps[MAX_STEPS];
    uint8_t degrees[MAX_STEPS];
    uint8_t octaves[MAX_STEPS];
    int length;
    int position;
    int direction;       /* 0=fwd, 1=rev, 2=pingpong, 3=random */
    int pingpong_dir;

    /* Probabilities (0..1 in 0.001 units — stored as floats for now) */
    float density, accent, slide;
    int octave_range;    /* 1..3 */

    /* Key */
    int root;            /* 0=C .. 11=B */
    int scale;           /* index into SCALES */

    /* Timing */
    float bpm;
    float gate;          /* 0.1 .. 1.0 */
    int sync;            /* 0=internal, 1=external MIDI clock */
    int clock_pulses;
    double samples_per_step;
    double sample_accum; /* fractional progress within current step */
    long gate_samples_remaining;
    int channel;         /* 1..16 */
    int transpose;       /* semitones added to every emitted note */

    /* Playback */
    int running;
    int last_note_on;    /* -1 = none */
    int last_note_on_ch; /* cable/channel combined, for note-off */
    int portamento_on;

    /* Banks + seed */
    uint32_t seed;
    int current_bank;
    int pending_recall;   /* -1 = nothing queued; >=0 = bank to recall at next bar */
    uint8_t bank_steps[NUM_BANKS][MAX_STEPS];
    uint8_t bank_degrees[NUM_BANKS][MAX_STEPS];
    uint8_t bank_octaves[NUM_BANKS][MAX_STEPS];
    uint8_t bank_filled[NUM_BANKS];

    /* One-deep undo buffer — snapshot before any destructive action (generate,
     * mutate, clear). UI can call "undo" to restore. */
    uint8_t undo_steps[MAX_STEPS];
    uint8_t undo_degrees[MAX_STEPS];
    uint8_t undo_octaves[MAX_STEPS];
    int undo_valid;

    /* UI-observed step position (last advanced to) — JS UI polls this. */
    int ui_current_step;

    /* State persistence. tb3po_set_param runs on the audio thread (shim
     * dispatches from its SPI callback) so we can't do fopen/fwrite there —
     * it marks state_dirty instead, and a background worker thread (started
     * in create_instance, joined in destroy_instance) wakes up periodically
     * and flushes if the flag is set. destroy_instance also flushes one
     * last time synchronously. */
    volatile int state_dirty;
    volatile int state_thread_stop;
    pthread_t    state_thread;
    int          state_thread_started;
    pthread_mutex_t state_mutex;  /* guards the save itself so destroy can't
                                     race with the worker's fwrite */
} tb3po_inst_t;

/* ---------------------------------------------------------------------- */
/* PRNG                                                                   */
/* ---------------------------------------------------------------------- */

static uint32_t rng_next_u32(tb3po_inst_t *t) {
    uint32_t x = t->rng;
    if (x == 0) x = 1;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    t->rng = x;
    return x;
}

/* Returns float in [0, 1). */
static float rng_next_f(tb3po_inst_t *t) {
    return (float)(rng_next_u32(t) & 0xFFFFFF) / (float)0x1000000;
}

/* ---------------------------------------------------------------------- */
/* Pattern generation                                                     */
/* ---------------------------------------------------------------------- */

static void recompute_step_length(tb3po_inst_t *t) {
    /* 16ths per second = bpm / 60 * 4 */
    double sixteenths_per_sec = (double)t->bpm / 60.0 * 4.0;
    if (sixteenths_per_sec <= 0) sixteenths_per_sec = 8.0;
    t->samples_per_step = (double)SAMPLE_RATE / sixteenths_per_sec;
}

static void generate_pattern(tb3po_inst_t *t, uint32_t seed) {
    t->rng = seed ? seed : 1;
    const scale_t *sc = &SCALES[t->scale];
    for (int i = 0; i < t->length; i++) {
        if (rng_next_f(t) > t->density) {
            t->steps[i] = STEP_REST;
            continue;
        }
        int on_beat = (i % 4 == 0);
        int degree;
        if (on_beat && rng_next_f(t) < 0.35f) {
            degree = 0;
        } else {
            degree = (int)(rng_next_f(t) * (float)sc->len);
            if (degree >= sc->len) degree = sc->len - 1;
        }
        t->degrees[i] = (uint8_t)degree;
        int oct = (int)(rng_next_f(t) * (float)t->octave_range);
        if (oct >= t->octave_range) oct = t->octave_range - 1;
        t->octaves[i] = (uint8_t)oct;

        int s = STEP_NOTE;
        if (rng_next_f(t) < t->accent) s = STEP_ACCENT;
        if (rng_next_f(t) < t->slide) s = STEP_SLIDE;
        t->steps[i] = (uint8_t)s;
    }

    /* Cleanup: slide-into-rest is a noop, demote to plain note. */
    for (int i = 0; i < t->length; i++) {
        int nxt = (i + 1) % t->length;
        if (t->steps[i] == STEP_SLIDE && t->steps[nxt] == STEP_REST) {
            t->steps[i] = STEP_NOTE;
        }
    }

    /* Guarantee at least one note. */
    int any = 0;
    for (int i = 0; i < t->length; i++) if (t->steps[i] != STEP_REST) { any = 1; break; }
    if (!any) {
        t->steps[0] = STEP_NOTE;
        t->degrees[0] = 0;
        t->octaves[0] = 0;
    }
}

static void snapshot_undo(tb3po_inst_t *t) {
    memcpy(t->undo_steps,   t->steps,   MAX_STEPS);
    memcpy(t->undo_degrees, t->degrees, MAX_STEPS);
    memcpy(t->undo_octaves, t->octaves, MAX_STEPS);
    t->undo_valid = 1;
}

static void restore_undo(tb3po_inst_t *t) {
    if (!t->undo_valid) return;
    memcpy(t->steps,   t->undo_steps,   MAX_STEPS);
    memcpy(t->degrees, t->undo_degrees, MAX_STEPS);
    memcpy(t->octaves, t->undo_octaves, MAX_STEPS);
}

static void mutate_pattern(tb3po_inst_t *t) {
    const scale_t *sc = &SCALES[t->scale];
    for (int i = 0; i < t->length; i++) {
        if (rng_next_f(t) >= 0.25f) continue;
        if (rng_next_f(t) < 0.5f) {
            /* Re-roll step state. */
            if (rng_next_f(t) > t->density) {
                t->steps[i] = STEP_REST;
            } else {
                int s = STEP_NOTE;
                if (rng_next_f(t) < t->accent) s = STEP_ACCENT;
                if (rng_next_f(t) < t->slide) s = STEP_SLIDE;
                t->steps[i] = (uint8_t)s;
            }
        } else {
            int degree = (int)(rng_next_f(t) * (float)sc->len);
            if (degree >= sc->len) degree = sc->len - 1;
            t->degrees[i] = (uint8_t)degree;
            int oct = (int)(rng_next_f(t) * (float)t->octave_range);
            if (oct >= t->octave_range) oct = t->octave_range - 1;
            t->octaves[i] = (uint8_t)oct;
        }
    }
}

/* ---------------------------------------------------------------------- */
/* MIDI emission                                                          */
/* ---------------------------------------------------------------------- */

static int note_for_step(const tb3po_inst_t *t, int i) {
    const scale_t *sc = &SCALES[t->scale];
    /* Base in the C1 octave — three octaves below middle C. With root offset
     * 0..11 plus scale degrees up to 11 plus octave range up to 24, the max
     * emitted note stays below Move's pad-LED range (notes 68-99). */
    int base = 24 + t->root;
    int note = base + sc->degrees[t->degrees[i]] + 12 * t->octaves[i] + t->transpose;
    if (note < 0) note = 0;
    if (note > 127) note = 127;
    return note;
}

static void send_midi(tb3po_inst_t *t, uint8_t status, uint8_t d1, uint8_t d2) {
    if (!t->host) return;
    /* Internal routing only. The shim's midi_send_external does a real SPI
     * ioctl synchronously, which is not safe from render_block — calling it
     * multiple times per step (at 16th-note rate) blows the audio budget
     * and causes audible glitches. Use shadow slots with receive_channel
     * matched to TB-3PO's channel to route MIDI to a synth. */
    uint8_t pkt_int[4] = { (uint8_t)((status >> 4) & 0x0F), status, d1, d2 };
    if (t->host->midi_send_internal) t->host->midi_send_internal(pkt_int, 4);
}

static void kill_last_note(tb3po_inst_t *t) {
    if (t->last_note_on < 0) return;
    uint8_t ch = (uint8_t)((t->channel - 1) & 0x0F);
    send_midi(t, 0x80 | ch, (uint8_t)t->last_note_on, 0);
    t->last_note_on = -1;
}

static void emit_step(tb3po_inst_t *t, int prev_idx, int idx) {
    uint8_t ch = (uint8_t)((t->channel - 1) & 0x0F);
    uint8_t step = t->steps[idx];
    if (step == STEP_REST) { kill_last_note(t); t->gate_samples_remaining = 0; return; }

    int note = note_for_step(t, idx);
    int is_accent = (step == STEP_ACCENT);
    uint8_t vel = is_accent ? 118 : 72;
    int was_slide = (prev_idx >= 0 && t->steps[prev_idx] == STEP_SLIDE);

    if (was_slide) {
        if (!t->portamento_on) {
            send_midi(t, 0xB0 | ch, 65, 127);
            t->portamento_on = 1;
        }
        send_midi(t, 0x90 | ch, (uint8_t)note, vel);
        if (t->last_note_on >= 0 && t->last_note_on != note) {
            send_midi(t, 0x80 | ch, (uint8_t)t->last_note_on, 0);
        }
    } else {
        if (t->portamento_on) {
            send_midi(t, 0xB0 | ch, 65, 0);
            t->portamento_on = 0;
        }
        kill_last_note(t);
        send_midi(t, 0x90 | ch, (uint8_t)note, vel);
    }
    t->last_note_on = note;
    t->gate_samples_remaining = (long)(t->samples_per_step * t->gate);
}

static int next_position(tb3po_inst_t *t) {
    switch (t->direction) {
        case 1: return (t->position - 1 + t->length) % t->length;
        case 2: {
            int n = t->position + t->pingpong_dir;
            if (n >= t->length || n < 0) {
                t->pingpong_dir = -t->pingpong_dir;
                n = t->position + t->pingpong_dir;
            }
            return n;
        }
        case 3: {
            int n = (int)(rng_next_f(t) * (float)t->length);
            if (n >= t->length) n = t->length - 1;
            return n;
        }
        default: return (t->position + 1) % t->length;
    }
}

static void advance_step(tb3po_inst_t *t) {
    int prev = t->position;
    int n = next_position(t);
    /* At bar boundaries (position wraps to 0 on a forward pass), honour a
     * queued bank recall so pattern switches happen musically rather than
     * mid-phrase. */
    if (n == 0 && t->pending_recall >= 0 && t->pending_recall < NUM_BANKS) {
        int b = t->pending_recall;
        if (t->bank_filled[b]) {
            memcpy(t->steps, t->bank_steps[b], MAX_STEPS);
            memcpy(t->degrees, t->bank_degrees[b], MAX_STEPS);
            memcpy(t->octaves, t->bank_octaves[b], MAX_STEPS);
            t->current_bank = b;
        }
        t->pending_recall = -1;
    }
    t->position = n;
    t->ui_current_step = n;
    emit_step(t, prev, n);
}

/* ---------------------------------------------------------------------- */
/* State persistence — fixed-layout binary format                         */
/* ---------------------------------------------------------------------- */
/*
 * Laid out to survive full-exit teardowns of the module: pattern + all 8
 * banks + seeds + every knob-tunable param. On tb3po_create() we attempt
 * to load; on tb3po_destroy() (and on explicit "save_state" requests) we
 * write. If the file is missing / magic mismatches / version is wrong,
 * we silently keep the hard-coded defaults. Intentionally NOT saved:
 * transport follow state, running flag (always re-derived from the host
 * clock on load), position, pending_recall, undo buffer.
 */
static int ensure_state_dir(void) {
    struct stat st;
    if (stat(TB3PO_STATE_DIR, &st) == 0 && S_ISDIR(st.st_mode)) return 1;
    if (mkdir(TB3PO_STATE_DIR, 0755) == 0) return 1;
    /* Check again in case another process just made it. */
    return (stat(TB3PO_STATE_DIR, &st) == 0 && S_ISDIR(st.st_mode));
}

static int tb3po_save_state_locked(const tb3po_inst_t *t) {
    if (!t) return 0;
    if (!ensure_state_dir()) return 0;
    FILE *f = fopen(TB3PO_STATE_PATH, "wb");
    if (!f) return 0;

    uint32_t magic = TB3PO_STATE_MAGIC;
    uint32_t ver = TB3PO_STATE_VERSION;
    fwrite(&magic, sizeof(magic), 1, f);
    fwrite(&ver,   sizeof(ver),   1, f);

    /* Scalars — match tb3po_load_state() exactly. */
    int32_t i32;
    float   fval;
    uint32_t u32;

    i32 = (int32_t)t->length;         fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)t->direction;      fwrite(&i32, sizeof(i32), 1, f);
    fval = t->density;                fwrite(&fval, sizeof(fval), 1, f);
    fval = t->accent;                 fwrite(&fval, sizeof(fval), 1, f);
    fval = t->slide;                  fwrite(&fval, sizeof(fval), 1, f);
    i32 = (int32_t)t->octave_range;   fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)t->root;           fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)t->scale;          fwrite(&i32, sizeof(i32), 1, f);
    fval = t->bpm;                    fwrite(&fval, sizeof(fval), 1, f);
    fval = t->gate;                   fwrite(&fval, sizeof(fval), 1, f);
    i32 = (int32_t)t->channel;        fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)t->transpose;      fwrite(&i32, sizeof(i32), 1, f);
    u32 = t->seed;                    fwrite(&u32, sizeof(u32), 1, f);
    i32 = (int32_t)t->current_bank;   fwrite(&i32, sizeof(i32), 1, f);

    /* Live pattern buffers (MAX_STEPS each). */
    fwrite(t->steps,   1, MAX_STEPS, f);
    fwrite(t->degrees, 1, MAX_STEPS, f);
    fwrite(t->octaves, 1, MAX_STEPS, f);

    /* All 8 banks. */
    for (int b = 0; b < NUM_BANKS; b++) {
        fwrite(t->bank_steps[b],   1, MAX_STEPS, f);
        fwrite(t->bank_degrees[b], 1, MAX_STEPS, f);
        fwrite(t->bank_octaves[b], 1, MAX_STEPS, f);
    }
    fwrite(t->bank_filled, 1, NUM_BANKS, f);

    fclose(f);
    return 1;
}

/* Public save entry point. Takes the state mutex so the background worker
 * and the destroy-instance flush don't race on the same FILE*. */
static int tb3po_save_state(tb3po_inst_t *t) {
    if (!t) return 0;
    pthread_mutex_lock(&t->state_mutex);
    int ok = tb3po_save_state_locked(t);
    pthread_mutex_unlock(&t->state_mutex);
    return ok;
}

/* Background worker: wake every 2s, check the dirty flag, flush if set.
 * Sleeping is interruptible because state_thread_stop is checked between
 * wakes — so destroy_instance can tear us down within ~2s in the worst
 * case (then the synchronous final save in destroy_instance catches any
 * edits that happened between the last worker tick and shutdown). */
static void *tb3po_state_worker(void *arg) {
    tb3po_inst_t *t = (tb3po_inst_t *)arg;
    while (!t->state_thread_stop) {
        /* Sleep in 200ms slices so destroy wakes us promptly. */
        for (int i = 0; i < 10 && !t->state_thread_stop; i++) {
            usleep(200 * 1000);
        }
        if (t->state_thread_stop) break;
        if (t->state_dirty) {
            if (tb3po_save_state(t)) t->state_dirty = 0;
            /* On failure leave dirty=1 so the next tick retries. */
        }
    }
    return NULL;
}

static int tb3po_load_state(tb3po_inst_t *t) {
    if (!t) return 0;
    FILE *f = fopen(TB3PO_STATE_PATH, "rb");
    if (!f) return 0;

    uint32_t magic = 0, ver = 0;
    if (fread(&magic, sizeof(magic), 1, f) != 1 || magic != TB3PO_STATE_MAGIC) {
        fclose(f); return 0;
    }
    if (fread(&ver, sizeof(ver), 1, f) != 1 || ver != TB3PO_STATE_VERSION) {
        fclose(f); return 0;
    }

    int32_t i32;
    float   fval;
    uint32_t u32;
    int ok = 1;

#define RD(buf, sz) do { if (fread((buf), (sz), 1, f) != 1) { ok = 0; goto done; } } while (0)

    RD(&i32, sizeof(i32));   t->length       = i32;
    RD(&i32, sizeof(i32));   t->direction    = i32;
    RD(&fval, sizeof(fval)); t->density      = fval;
    RD(&fval, sizeof(fval)); t->accent       = fval;
    RD(&fval, sizeof(fval)); t->slide        = fval;
    RD(&i32, sizeof(i32));   t->octave_range = i32;
    RD(&i32, sizeof(i32));   t->root         = i32;
    RD(&i32, sizeof(i32));   t->scale        = i32;
    RD(&fval, sizeof(fval)); t->bpm          = fval;
    RD(&fval, sizeof(fval)); t->gate         = fval;
    RD(&i32, sizeof(i32));   t->channel      = i32;
    RD(&i32, sizeof(i32));   t->transpose    = i32;
    RD(&u32, sizeof(u32));   t->seed         = u32;
    RD(&i32, sizeof(i32));   t->current_bank = i32;

    RD(t->steps,   MAX_STEPS);
    RD(t->degrees, MAX_STEPS);
    RD(t->octaves, MAX_STEPS);

    for (int b = 0; b < NUM_BANKS; b++) {
        RD(t->bank_steps[b],   MAX_STEPS);
        RD(t->bank_degrees[b], MAX_STEPS);
        RD(t->bank_octaves[b], MAX_STEPS);
    }
    RD(t->bank_filled, NUM_BANKS);

#undef RD

done:
    fclose(f);
    if (!ok) return 0;

    /* Clamp recovered scalars to known-safe ranges — a corrupt file
     * shouldn't be able to index past the end of an enum table etc. */
    if (t->length < 1 || t->length > MAX_STEPS) t->length = 16;
    if (t->direction < 0 || t->direction > 3) t->direction = 0;
    if (t->octave_range < 1 || t->octave_range > 3) t->octave_range = 2;
    if (t->root < 0 || t->root > 11) t->root = 9;
    if (t->scale < 0 || t->scale >= NUM_SCALES) t->scale = 0;
    if (t->channel < 1 || t->channel > 16) t->channel = 1;
    if (t->current_bank < 0 || t->current_bank >= NUM_BANKS) t->current_bank = 0;
    if (t->density < 0.0f) t->density = 0.0f;
    if (t->density > 1.0f) t->density = 1.0f;
    if (t->accent  < 0.0f) t->accent  = 0.0f;
    if (t->accent  > 1.0f) t->accent  = 1.0f;
    if (t->slide   < 0.0f) t->slide   = 0.0f;
    if (t->slide   > 1.0f) t->slide   = 1.0f;
    if (t->bpm < 20.0f || t->bpm > 400.0f) t->bpm = 120.0f;
    if (t->gate < 0.1f || t->gate > 1.0f) t->gate = 0.5f;
    return 1;
}

/* ---------------------------------------------------------------------- */
/* Plugin API surface                                                     */
/* ---------------------------------------------------------------------- */

static const host_api_v1_t *g_host = NULL;

static void *tb3po_create(const char *module_dir, const char *json_defaults) {
    (void)module_dir; (void)json_defaults;
    tb3po_inst_t *t = (tb3po_inst_t *)calloc(1, sizeof(tb3po_inst_t));
    if (!t) return NULL;
    t->host = g_host;
    t->rng = 0xBEEF;
    t->seed = 0xBEEF;
    t->length = 16;
    t->density = 0.7f;
    t->accent = 0.4f;
    t->slide = 0.25f;
    t->octave_range = 2;
    t->root = 9;  /* A */
    t->scale = 0;
    t->bpm = 120.0f;
    t->gate = 0.5f;
    t->sync = 0;
    t->channel = 1;
    /* Don't self-play on load. Wait for 0xFA/0xFB from the host transport,
     * or mark as running if transport is already playing when we come up. */
    t->running = 0;
    if (t->host && t->host->get_clock_status) {
        if (t->host->get_clock_status() == MOVE_CLOCK_STATUS_RUNNING) {
            t->running = 1;
        }
    }
    t->last_note_on = -1;
    t->position = t->length - 1;  /* first advance lands on 0 */
    t->pingpong_dir = 1;
    t->follow_transport = 1;  /* default: follow Move's transport */
    t->prev_clock_status = MOVE_CLOCK_STATUS_UNAVAILABLE;
    t->pending_recall = -1;

    /* Restore persisted state before computing derived values or
     * generating a pattern — if we load a pattern from disk we don't
     * want to overwrite it with a fresh random one. */
    int loaded = tb3po_load_state(t);

    recompute_step_length(t);
    if (!loaded) {
        /* No saved state — seed the default pattern so there's something to hear. */
        generate_pattern(t, t->seed);
    }
    t->position = t->length - 1;  /* reset position regardless */

    /* Initialise the background-saver: the mutex serializes writes, and the
     * worker thread polls state_dirty every ~2s. It's set detached so a
     * teardown doesn't leak the thread if pthread_join is skipped. */
    pthread_mutex_init(&t->state_mutex, NULL);
    t->state_dirty = 0;
    t->state_thread_stop = 0;
    t->state_thread_started = 0;
    if (pthread_create(&t->state_thread, NULL, tb3po_state_worker, t) == 0) {
        t->state_thread_started = 1;
    }
    return t;
}

static void tb3po_destroy(void *inst) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t) return;
    /* Release any hanging note + portamento state. */
    kill_last_note(t);
    if (t->portamento_on) {
        uint8_t ch = (uint8_t)((t->channel - 1) & 0x0F);
        send_midi(t, 0xB0 | ch, 65, 0);
        send_midi(t, 0xB0 | ch, 123, 0);
        t->portamento_on = 0;
    }
    /* Stop the background saver before tearing everything else down.
     * Set the stop flag, join (worker wakes within ~200ms), then do one
     * last synchronous save to catch edits that happened between the
     * worker's last tick and now. */
    t->state_thread_stop = 1;
    if (t->state_thread_started) {
        pthread_join(t->state_thread, NULL);
    }
    tb3po_save_state(t);
    pthread_mutex_destroy(&t->state_mutex);
    free(t);
}

static void tb3po_on_midi(void *inst, const uint8_t *msg, int len, int source) {
    (void)source;
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t || !msg || len < 1) return;
    uint8_t status = msg[0];
    if (status == 0xF8) {
        /* MIDI clock tick (24 PPQN). Advance immediately here rather than
         * accumulating into a per-block counter — on_midi runs on the same
         * audio thread as render_block, so emitting MIDI from here is safe
         * and avoids a ~2.9 ms block of jitter. */
        t->pulse_sync_active = 1;
        t->blocks_since_last_pulse = 0;
        if (t->running) {
            t->clock_pulses = (t->clock_pulses + 1) % 6;
            if (t->clock_pulses == 0) advance_step(t);
        }
        return;
    }
    if (status == 0xFA) {
        /* Start — park clock_pulses at 5 so the very first 0xF8 bumps it to
         * 0 and fires step 0 on the downbeat (the MIDI convention). Before
         * this, clock_pulses started at 0 which meant the first step didn't
         * fire until the 6th pulse — one full 16th late. */
        if (t->follow_transport) {
            t->running = 1;
            t->position = t->length - 1;  /* next advance lands on 0 */
            t->clock_pulses = 5;
            t->sample_accum = 0;
        }
        return;
    }
    if (status == 0xFB) {
        /* Continue — resume without resetting position/clock_pulses. */
        if (t->follow_transport) t->running = 1;
        return;
    }
    if (status == 0xFC) {
        /* Stop — release notes. */
        if (t->follow_transport) {
            t->running = 0;
            kill_last_note(t);
            if (t->portamento_on) {
                uint8_t ch = (uint8_t)((t->channel - 1) & 0x0F);
                send_midi(t, 0xB0 | ch, 65, 0);
                t->portamento_on = 0;
            }
        }
        return;
    }
    /* Other MIDI ignored for now. */
}

static int parse_int(const char *s, int fallback) {
    if (!s || !*s) return fallback;
    return (int)strtol(s, NULL, 10);
}
static float parse_float(const char *s, float fallback) {
    if (!s || !*s) return fallback;
    return (float)strtod(s, NULL);
}

static void tb3po_set_param(void *inst, const char *key, const char *val) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t || !key) return;
    if (strcmp(key, "density") == 0)      t->density = parse_float(val, 0.7f);
    else if (strcmp(key, "accent") == 0)  t->accent = parse_float(val, 0.4f);
    else if (strcmp(key, "slide") == 0)   t->slide = parse_float(val, 0.25f);
    else if (strcmp(key, "octaves") == 0) { t->octave_range = parse_int(val, 2); if (t->octave_range < 1) t->octave_range = 1; if (t->octave_range > 3) t->octave_range = 3; }
    else if (strcmp(key, "root") == 0)    { t->root = parse_int(val, 9) % 12; if (t->root < 0) t->root += 12; }
    else if (strcmp(key, "scale") == 0)   { t->scale = parse_int(val, 0); if (t->scale < 0 || t->scale >= NUM_SCALES) t->scale = 0; }
    else if (strcmp(key, "length") == 0)  { int v = parse_int(val, 16); if (v < 2) v = 2; if (v > MAX_STEPS) v = MAX_STEPS; t->length = v; if (t->position >= v) t->position = v - 1; }
    else if (strcmp(key, "gate") == 0)    { t->gate = parse_float(val, 0.5f); if (t->gate < 0.05f) t->gate = 0.05f; if (t->gate > 1.0f) t->gate = 1.0f; }
    else if (strcmp(key, "bpm") == 0)     { t->bpm = parse_float(val, 120.0f); if (t->bpm < 20.0f) t->bpm = 20.0f; if (t->bpm > 400.0f) t->bpm = 400.0f; recompute_step_length(t); }
    else if (strcmp(key, "sync") == 0)    t->sync = parse_int(val, 0) ? 1 : 0;
    else if (strcmp(key, "channel") == 0) { int c = parse_int(val, 1); if (c < 1) c = 1; if (c > 16) c = 16; t->channel = c; }
    else if (strcmp(key, "transpose") == 0) { int s = parse_int(val, 0); if (s < -48) s = -48; if (s > 48) s = 48; t->transpose = s; }
    else if (strcmp(key, "direction") == 0) t->direction = parse_int(val, 0) & 3;
    /* generate/regen/seed rewrite the pattern in place — keep the current
     * playhead so the sequence stays bar-aligned with whatever other tracks
     * the user is running against Move's transport. Otherwise pressing NEW
     * mid-bar snapped us back to step 0 and knocked tb3po out of phase. */
    else if (strcmp(key, "seed") == 0)    { t->seed = (uint32_t)parse_int(val, 0xBEEF); generate_pattern(t, t->seed); }
    else if (strcmp(key, "generate") == 0) { snapshot_undo(t); t->seed = rng_next_u32(t); generate_pattern(t, t->seed); }
    else if (strcmp(key, "regen") == 0)    { snapshot_undo(t); generate_pattern(t, t->seed); }
    else if (strcmp(key, "mutate") == 0)   { snapshot_undo(t); mutate_pattern(t); }
    else if (strcmp(key, "clear") == 0)    { snapshot_undo(t); for (int i = 0; i < MAX_STEPS; i++) t->steps[i] = STEP_REST; t->steps[0] = STEP_NOTE; }
    else if (strcmp(key, "undo") == 0)     restore_undo(t);
    else if (strcmp(key, "store_bank") == 0) {
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS) {
            memcpy(t->bank_steps[b], t->steps, MAX_STEPS);
            memcpy(t->bank_degrees[b], t->degrees, MAX_STEPS);
            memcpy(t->bank_octaves[b], t->octaves, MAX_STEPS);
            t->bank_filled[b] = 1;
            t->current_bank = b;
        }
    }
    else if (strcmp(key, "recall_bank") == 0) {
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS && t->bank_filled[b]) {
            /* Queue the recall. It will apply on the next bar boundary inside
             * advance_step so pattern switches line up musically. */
            t->pending_recall = b;
        }
    }
    else if (strcmp(key, "recall_bank_now") == 0) {
        /* Escape hatch: apply immediately (e.g. when transport is stopped and
         * there's no bar boundary coming). */
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS && t->bank_filled[b]) {
            memcpy(t->steps, t->bank_steps[b], MAX_STEPS);
            memcpy(t->degrees, t->bank_degrees[b], MAX_STEPS);
            memcpy(t->octaves, t->bank_octaves[b], MAX_STEPS);
            t->current_bank = b;
            t->pending_recall = -1;
        }
    }
    else if (strcmp(key, "running") == 0) {
        int r = parse_int(val, 1) ? 1 : 0;
        if (!r && t->running) kill_last_note(t);
        t->running = r;
    }
    else if (strcmp(key, "set_step") == 0) {
        /* format: "idx:kind[:degree:octave]" */
        if (!val) return;
        int idx = 0, kind = STEP_REST, deg = 0, oct = 0;
        int n = sscanf(val, "%d:%d:%d:%d", &idx, &kind, &deg, &oct);
        if (n >= 2 && idx >= 0 && idx < MAX_STEPS) {
            t->steps[idx] = (uint8_t)(kind & 3);
            if (n >= 3) t->degrees[idx] = (uint8_t)deg;
            if (n >= 4) t->octaves[idx] = (uint8_t)oct;
            if (t->host && t->host->log) {
                char m[64]; snprintf(m, sizeof(m), "tb3po set_step idx=%d kind=%d", idx, kind);
                t->host->log(m);
            }
        }
    }
    else if (strcmp(key, "follow_transport") == 0) {
        t->follow_transport = parse_int(val, 1) ? 1 : 0;
    }

    /* Any set_param that lands here changed persisted (or paranoid-safe to
     * resave) state. Mark dirty — render_block will flush the file a few
     * seconds later, batching rapid edits into a single write. */
    t->state_dirty = 1;
}

static int tb3po_get_param(void *inst, const char *key, char *buf, int buf_len) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t || !key || !buf || buf_len < 2) return -1;
    int n = 0;
    if (strcmp(key, "position") == 0)        n = snprintf(buf, buf_len, "%d", t->ui_current_step);
    else if (strcmp(key, "length") == 0)     n = snprintf(buf, buf_len, "%d", t->length);
    else if (strcmp(key, "density") == 0)    n = snprintf(buf, buf_len, "%.3f", t->density);
    else if (strcmp(key, "accent") == 0)     n = snprintf(buf, buf_len, "%.3f", t->accent);
    else if (strcmp(key, "slide") == 0)      n = snprintf(buf, buf_len, "%.3f", t->slide);
    else if (strcmp(key, "octaves") == 0)    n = snprintf(buf, buf_len, "%d", t->octave_range);
    else if (strcmp(key, "root") == 0)       n = snprintf(buf, buf_len, "%d", t->root);
    else if (strcmp(key, "scale") == 0)      n = snprintf(buf, buf_len, "%d", t->scale);
    else if (strcmp(key, "gate") == 0)       n = snprintf(buf, buf_len, "%.3f", t->gate);
    else if (strcmp(key, "bpm") == 0)        n = snprintf(buf, buf_len, "%.1f", t->bpm);
    else if (strcmp(key, "sync") == 0)       n = snprintf(buf, buf_len, "%d", t->sync);
    else if (strcmp(key, "channel") == 0)    n = snprintf(buf, buf_len, "%d", t->channel);
    else if (strcmp(key, "transpose") == 0)  n = snprintf(buf, buf_len, "%d", t->transpose);
    else if (strcmp(key, "direction") == 0)  n = snprintf(buf, buf_len, "%d", t->direction);
    else if (strcmp(key, "seed") == 0)       n = snprintf(buf, buf_len, "%u", (unsigned)t->seed);
    else if (strcmp(key, "current_bank") == 0) n = snprintf(buf, buf_len, "%d", t->current_bank);
    else if (strcmp(key, "pending_recall") == 0) n = snprintf(buf, buf_len, "%d", t->pending_recall);
    else if (strcmp(key, "bank_filled") == 0) {
        int off = 0;
        for (int i = 0; i < NUM_BANKS && off < buf_len - 1; i++) {
            buf[off++] = t->bank_filled[i] ? '1' : '0';
        }
        buf[off] = '\0';
        n = off;
    }
    else if (strcmp(key, "running") == 0)    n = snprintf(buf, buf_len, "%d", t->running ? 1 : 0);
    else if (strcmp(key, "follow_transport") == 0) n = snprintf(buf, buf_len, "%d", t->follow_transport ? 1 : 0);
    else if (strcmp(key, "clock_status") == 0) n = snprintf(buf, buf_len, "%d", t->host_clock_status);
    else if (strcmp(key, "sync_source") == 0) n = snprintf(buf, buf_len, "%s", t->pulse_sync_active ? "EXT" : "INT");
    else if (strcmp(key, "pattern") == 0) {
        /* Compact row: "len|steps|degs|octs" — pipe-separated, each is comma-separated ints. */
        int off = 0;
        off += snprintf(buf + off, buf_len - off, "%d|", t->length);
        for (int i = 0; i < t->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", t->steps[i]);
        if (off < buf_len - 2) off += snprintf(buf + off, buf_len - off, "|");
        for (int i = 0; i < t->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", t->degrees[i]);
        if (off < buf_len - 2) off += snprintf(buf + off, buf_len - off, "|");
        for (int i = 0; i < t->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", t->octaves[i]);
        n = off;
    }
    else return -1;
    if (n < 0) return -1;
    if (n >= buf_len) n = buf_len - 1;
    return n;
}

static int tb3po_get_error(void *inst, char *buf, int buf_len) {
    (void)inst; (void)buf; (void)buf_len; return 0;
}

static void tb3po_render_block(void *inst, int16_t *out_lr, int frames) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    /* No audio output — this is a MIDI generator. */
    if (out_lr && frames > 0) memset(out_lr, 0, sizeof(int16_t) * frames * 2);
    if (!t) return;


    /* Pulse-driven sync: on_midi now advances steps directly as 0xF8 pulses
     * arrive (same audio thread as render_block). Here we just age out
     * pulse_sync_active if clock pulses stop, so we fall back to the internal
     * timer after ~580 ms of silence. */
    if (t->pulse_sync_active) {
        t->blocks_since_last_pulse++;
        if (t->blocks_since_last_pulse > 200) {
            t->pulse_sync_active = 0;
            t->clock_pulses = 0;
        }
        t->sample_accum = 0;
    }

    /* === BPM polling (for internal-timer mode) =========================== */
    if ((++t->poll_counter & 0x1F) == 0 && t->host && t->host->get_bpm) {
        float hb = t->host->get_bpm();
        if (hb > 20.0f && hb < 400.0f && hb != t->host_bpm) {
            t->host_bpm = hb;
            t->bpm = hb;
            recompute_step_length(t);
        }
    }

    /* (Transport follow is now driven purely by the explicit 0xFA/0xFB/0xFC
     * messages delivered by the shim in on_midi — no polling get_clock_status,
     * which raced with the MIDI path and caused the "sometimes stops / sometimes
     * restarts" glitches.) */

    if (!t->running) return;

    /* === Internal timer mode (no clock pulses) ============================ */
    if (!t->pulse_sync_active) {
        t->sample_accum += (double)frames;
        while (t->sample_accum >= t->samples_per_step) {
            t->sample_accum -= t->samples_per_step;
            advance_step(t);
        }
    }

    /* Gate off after gate_samples_remaining elapses, unless next step is slide. */
    if (t->gate_samples_remaining > 0) {
        t->gate_samples_remaining -= frames;
        if (t->gate_samples_remaining <= 0) {
            t->gate_samples_remaining = 0;
            /* Only release if the CURRENT step isn't slide (slide = hold until next note). */
            if (t->steps[t->position] != STEP_SLIDE) kill_last_note(t);
        }
    }
}

static plugin_api_v2_t tb3po_api_v2 = {
    .api_version     = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = tb3po_create,
    .destroy_instance = tb3po_destroy,
    .on_midi         = tb3po_on_midi,
    .set_param       = tb3po_set_param,
    .get_param       = tb3po_get_param,
    .get_error       = tb3po_get_error,
    .render_block    = tb3po_render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host) {
    g_host = host;
    return &tb3po_api_v2;
}
