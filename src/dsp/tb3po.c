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
#define NUM_SLOTS   2

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

/* Per-slot sequencer state. Every field here is "owned" by one of the two
 * slots — they advance independently on the shared clock and emit MIDI on
 * their own channel. Shared state (transport, clock counter, host bindings,
 * persistence worker) lives on tb3po_inst_t. */
typedef struct tb3po_slot {
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

    /* Voice params */
    float gate;          /* 0.1 .. 1.0 */
    int channel;         /* 1..16 */
    int transpose;       /* semitones added to every emitted note */

    /* Playback */
    int last_note_on;    /* -1 = none */
    int last_note_on_ch; /* cable/channel combined, for note-off */
    int portamento_on;
    long gate_samples_remaining;

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
} tb3po_slot_t;

typedef struct tb3po_inst {
    const host_api_v1_t *host;

    /* Two parallel slots (A/B). Both advance on the shared clock; each emits
     * on its own MIDI channel. active_slot tells the DSP which slot the
     * 303 Control CC knob path is addressing (Task 5 wires the CC routing).
     * For Task 3 slot 1 advances silently — MIDI emission is gated to slot 0
     * until Task 4 turns it on. */
    tb3po_slot_t slots[NUM_SLOTS];
    int active_slot;   /* 0 or 1 */

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

    /* Shared clock. Both slots advance on the same tick of this counter. */
    float bpm;
    int sync;            /* 0=internal, 1=external MIDI clock */
    int clock_pulses;
    double samples_per_step;
    double sample_accum; /* fractional progress within current step */

    /* Global transport */
    int running;

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

static uint32_t rng_next_u32(tb3po_slot_t *s) {
    uint32_t x = s->rng;
    if (x == 0) x = 1;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    s->rng = x;
    return x;
}

/* Returns float in [0, 1). */
static float rng_next_f(tb3po_slot_t *s) {
    return (float)(rng_next_u32(s) & 0xFFFFFF) / (float)0x1000000;
}

/* ---------------------------------------------------------------------- */
/* Slot defaults                                                          */
/* ---------------------------------------------------------------------- */

static void slot_init_defaults(tb3po_slot_t *s) {
    memset(s, 0, sizeof(*s));
    s->rng = 0xBEEF;
    s->seed = 0xBEEF;
    s->length = 16;
    s->density = 0.7f;
    s->accent = 0.4f;
    s->slide = 0.25f;
    s->octave_range = 2;
    s->root = 9;  /* A */
    s->scale = 0;
    s->gate = 0.5f;
    s->channel = 1;
    s->last_note_on = -1;
    s->position = s->length - 1;  /* first advance lands on 0 */
    s->pingpong_dir = 1;
    s->pending_recall = -1;
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

static void generate_pattern(tb3po_slot_t *s, uint32_t seed) {
    s->rng = seed ? seed : 1;
    const scale_t *sc = &SCALES[s->scale];
    for (int i = 0; i < s->length; i++) {
        if (rng_next_f(s) > s->density) {
            s->steps[i] = STEP_REST;
            continue;
        }
        int on_beat = (i % 4 == 0);
        int degree;
        if (on_beat && rng_next_f(s) < 0.35f) {
            degree = 0;
        } else {
            degree = (int)(rng_next_f(s) * (float)sc->len);
            if (degree >= sc->len) degree = sc->len - 1;
        }
        s->degrees[i] = (uint8_t)degree;
        int oct = (int)(rng_next_f(s) * (float)s->octave_range);
        if (oct >= s->octave_range) oct = s->octave_range - 1;
        s->octaves[i] = (uint8_t)oct;

        int kind = STEP_NOTE;
        if (rng_next_f(s) < s->accent) kind = STEP_ACCENT;
        if (rng_next_f(s) < s->slide) kind = STEP_SLIDE;
        s->steps[i] = (uint8_t)kind;
    }

    /* Cleanup: slide-into-rest is a noop, demote to plain note. */
    for (int i = 0; i < s->length; i++) {
        int nxt = (i + 1) % s->length;
        if (s->steps[i] == STEP_SLIDE && s->steps[nxt] == STEP_REST) {
            s->steps[i] = STEP_NOTE;
        }
    }

    /* Guarantee at least one note. */
    int any = 0;
    for (int i = 0; i < s->length; i++) if (s->steps[i] != STEP_REST) { any = 1; break; }
    if (!any) {
        s->steps[0] = STEP_NOTE;
        s->degrees[0] = 0;
        s->octaves[0] = 0;
    }
}

static void snapshot_undo(tb3po_slot_t *s) {
    memcpy(s->undo_steps,   s->steps,   MAX_STEPS);
    memcpy(s->undo_degrees, s->degrees, MAX_STEPS);
    memcpy(s->undo_octaves, s->octaves, MAX_STEPS);
    s->undo_valid = 1;
}

static void restore_undo(tb3po_slot_t *s) {
    if (!s->undo_valid) return;
    memcpy(s->steps,   s->undo_steps,   MAX_STEPS);
    memcpy(s->degrees, s->undo_degrees, MAX_STEPS);
    memcpy(s->octaves, s->undo_octaves, MAX_STEPS);
}

static void mutate_pattern(tb3po_slot_t *s) {
    const scale_t *sc = &SCALES[s->scale];
    for (int i = 0; i < s->length; i++) {
        if (rng_next_f(s) >= 0.25f) continue;
        if (rng_next_f(s) < 0.5f) {
            /* Re-roll step state. */
            if (rng_next_f(s) > s->density) {
                s->steps[i] = STEP_REST;
            } else {
                int kind = STEP_NOTE;
                if (rng_next_f(s) < s->accent) kind = STEP_ACCENT;
                if (rng_next_f(s) < s->slide) kind = STEP_SLIDE;
                s->steps[i] = (uint8_t)kind;
            }
        } else {
            int degree = (int)(rng_next_f(s) * (float)sc->len);
            if (degree >= sc->len) degree = sc->len - 1;
            s->degrees[i] = (uint8_t)degree;
            int oct = (int)(rng_next_f(s) * (float)s->octave_range);
            if (oct >= s->octave_range) oct = s->octave_range - 1;
            s->octaves[i] = (uint8_t)oct;
        }
    }
}

/* ---------------------------------------------------------------------- */
/* MIDI emission                                                          */
/* ---------------------------------------------------------------------- */

static int note_for_step(const tb3po_slot_t *s, int i) {
    const scale_t *sc = &SCALES[s->scale];
    /* Base in the C1 octave — three octaves below middle C. With root offset
     * 0..11 plus scale degrees up to 11 plus octave range up to 24, the max
     * emitted note stays below Move's pad-LED range (notes 68-99). */
    int base = 24 + s->root;
    int note = base + sc->degrees[s->degrees[i]] + 12 * s->octaves[i] + s->transpose;
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

static void kill_last_note(tb3po_inst_t *t, tb3po_slot_t *s) {
    if (s->last_note_on < 0) return;
    uint8_t ch = (uint8_t)((s->channel - 1) & 0x0F);
    send_midi(t, 0x80 | ch, (uint8_t)s->last_note_on, 0);
    s->last_note_on = -1;
}

static void emit_step(tb3po_inst_t *t, tb3po_slot_t *s, int prev_idx, int idx) {
    uint8_t ch = (uint8_t)((s->channel - 1) & 0x0F);
    uint8_t kind = s->steps[idx];
    if (kind == STEP_REST) { kill_last_note(t, s); s->gate_samples_remaining = 0; return; }

    int note = note_for_step(s, idx);
    int is_accent = (kind == STEP_ACCENT);
    uint8_t vel = is_accent ? 118 : 72;
    int was_slide = (prev_idx >= 0 && s->steps[prev_idx] == STEP_SLIDE);

    if (was_slide) {
        if (!s->portamento_on) {
            send_midi(t, 0xB0 | ch, 65, 127);
            s->portamento_on = 1;
        }
        send_midi(t, 0x90 | ch, (uint8_t)note, vel);
        if (s->last_note_on >= 0 && s->last_note_on != note) {
            send_midi(t, 0x80 | ch, (uint8_t)s->last_note_on, 0);
        }
    } else {
        if (s->portamento_on) {
            send_midi(t, 0xB0 | ch, 65, 0);
            s->portamento_on = 0;
        }
        kill_last_note(t, s);
        send_midi(t, 0x90 | ch, (uint8_t)note, vel);
    }
    s->last_note_on = note;
    s->gate_samples_remaining = (long)(t->samples_per_step * s->gate);
}

static int next_position(tb3po_slot_t *s) {
    switch (s->direction) {
        case 1: return (s->position - 1 + s->length) % s->length;
        case 2: {
            int n = s->position + s->pingpong_dir;
            if (n >= s->length || n < 0) {
                s->pingpong_dir = -s->pingpong_dir;
                n = s->position + s->pingpong_dir;
            }
            return n;
        }
        case 3: {
            int n = (int)(rng_next_f(s) * (float)s->length);
            if (n >= s->length) n = s->length - 1;
            return n;
        }
        default: return (s->position + 1) % s->length;
    }
}

/* Advance one slot by one step. emit_midi controls whether note on/off goes
 * out for this slot — Task 3 gates slot 1's emission to keep the second slot
 * silent until Task 4 turns on parallel playback. */
static void advance_step(tb3po_inst_t *t, tb3po_slot_t *s, int emit_midi) {
    int prev = s->position;
    int n = next_position(s);
    /* At bar boundaries (position wraps to 0 on a forward pass), honour a
     * queued bank recall so pattern switches happen musically rather than
     * mid-phrase. */
    if (n == 0 && s->pending_recall >= 0 && s->pending_recall < NUM_BANKS) {
        int b = s->pending_recall;
        if (s->bank_filled[b]) {
            memcpy(s->steps, s->bank_steps[b], MAX_STEPS);
            memcpy(s->degrees, s->bank_degrees[b], MAX_STEPS);
            memcpy(s->octaves, s->bank_octaves[b], MAX_STEPS);
            s->current_bank = b;
        }
        s->pending_recall = -1;
    }
    s->position = n;
    s->ui_current_step = n;
    if (emit_midi) {
        emit_step(t, s, prev, n);
    }
    /* TODO(Task 4): enable slot 1 MIDI emission by passing emit_midi=true
     * for both slots in advance_all_slots() below. */
}

/* Advance every slot one step on a single clock tick. Slot 0 emits MIDI;
 * slot 1 advances silently for now. */
static void advance_all_slots(tb3po_inst_t *t) {
    for (int i = 0; i < NUM_SLOTS; i++) {
        int emit = (i == 0);
        advance_step(t, &t->slots[i], emit);
    }
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
 *
 * TODO(Task 6): bump to version 2 and serialize both slots. For Task 3
 * we only save slots[0] (effectively the v1 format) so Task 3 doesn't
 * drop existing saves; slot 1 stays at in-memory defaults across restarts.
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

    /* Scalars — match tb3po_load_state() exactly. Task 3 persists slot 0
     * only; slot 1 comes along in Task 6. */
    const tb3po_slot_t *s = &t->slots[0];
    int32_t i32;
    float   fval;
    uint32_t u32;

    i32 = (int32_t)s->length;         fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)s->direction;      fwrite(&i32, sizeof(i32), 1, f);
    fval = s->density;                fwrite(&fval, sizeof(fval), 1, f);
    fval = s->accent;                 fwrite(&fval, sizeof(fval), 1, f);
    fval = s->slide;                  fwrite(&fval, sizeof(fval), 1, f);
    i32 = (int32_t)s->octave_range;   fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)s->root;           fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)s->scale;          fwrite(&i32, sizeof(i32), 1, f);
    fval = t->bpm;                    fwrite(&fval, sizeof(fval), 1, f);
    fval = s->gate;                   fwrite(&fval, sizeof(fval), 1, f);
    i32 = (int32_t)s->channel;        fwrite(&i32, sizeof(i32), 1, f);
    i32 = (int32_t)s->transpose;      fwrite(&i32, sizeof(i32), 1, f);
    u32 = s->seed;                    fwrite(&u32, sizeof(u32), 1, f);
    i32 = (int32_t)s->current_bank;   fwrite(&i32, sizeof(i32), 1, f);

    /* Live pattern buffers (MAX_STEPS each). */
    fwrite(s->steps,   1, MAX_STEPS, f);
    fwrite(s->degrees, 1, MAX_STEPS, f);
    fwrite(s->octaves, 1, MAX_STEPS, f);

    /* All 8 banks. */
    for (int b = 0; b < NUM_BANKS; b++) {
        fwrite(s->bank_steps[b],   1, MAX_STEPS, f);
        fwrite(s->bank_degrees[b], 1, MAX_STEPS, f);
        fwrite(s->bank_octaves[b], 1, MAX_STEPS, f);
    }
    fwrite(s->bank_filled, 1, NUM_BANKS, f);

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

    /* Task 3 loads into slot 0 only — matches the v1 writer. */
    tb3po_slot_t *s = &t->slots[0];
    int32_t i32;
    float   fval;
    uint32_t u32;
    int ok = 1;

#define RD(buf, sz) do { if (fread((buf), (sz), 1, f) != 1) { ok = 0; goto done; } } while (0)

    RD(&i32, sizeof(i32));   s->length       = i32;
    RD(&i32, sizeof(i32));   s->direction    = i32;
    RD(&fval, sizeof(fval)); s->density      = fval;
    RD(&fval, sizeof(fval)); s->accent       = fval;
    RD(&fval, sizeof(fval)); s->slide        = fval;
    RD(&i32, sizeof(i32));   s->octave_range = i32;
    RD(&i32, sizeof(i32));   s->root         = i32;
    RD(&i32, sizeof(i32));   s->scale        = i32;
    RD(&fval, sizeof(fval)); t->bpm          = fval;
    RD(&fval, sizeof(fval)); s->gate         = fval;
    RD(&i32, sizeof(i32));   s->channel      = i32;
    RD(&i32, sizeof(i32));   s->transpose    = i32;
    RD(&u32, sizeof(u32));   s->seed         = u32;
    RD(&i32, sizeof(i32));   s->current_bank = i32;

    RD(s->steps,   MAX_STEPS);
    RD(s->degrees, MAX_STEPS);
    RD(s->octaves, MAX_STEPS);

    for (int b = 0; b < NUM_BANKS; b++) {
        RD(s->bank_steps[b],   MAX_STEPS);
        RD(s->bank_degrees[b], MAX_STEPS);
        RD(s->bank_octaves[b], MAX_STEPS);
    }
    RD(s->bank_filled, NUM_BANKS);

#undef RD

done:
    fclose(f);
    if (!ok) return 0;

    /* Clamp recovered scalars to known-safe ranges — a corrupt file
     * shouldn't be able to index past the end of an enum table etc. */
    if (s->length < 1 || s->length > MAX_STEPS) s->length = 16;
    if (s->direction < 0 || s->direction > 3) s->direction = 0;
    if (s->octave_range < 1 || s->octave_range > 3) s->octave_range = 2;
    if (s->root < 0 || s->root > 11) s->root = 9;
    if (s->scale < 0 || s->scale >= NUM_SCALES) s->scale = 0;
    if (s->channel < 1 || s->channel > 16) s->channel = 1;
    if (s->current_bank < 0 || s->current_bank >= NUM_BANKS) s->current_bank = 0;
    if (s->density < 0.0f) s->density = 0.0f;
    if (s->density > 1.0f) s->density = 1.0f;
    if (s->accent  < 0.0f) s->accent  = 0.0f;
    if (s->accent  > 1.0f) s->accent  = 1.0f;
    if (s->slide   < 0.0f) s->slide   = 0.0f;
    if (s->slide   > 1.0f) s->slide   = 1.0f;
    if (t->bpm < 20.0f || t->bpm > 400.0f) t->bpm = 120.0f;
    if (s->gate < 0.1f || s->gate > 1.0f) s->gate = 0.5f;
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

    /* Initialise both slots with the same defaults; override B's channel. */
    for (int i = 0; i < NUM_SLOTS; i++) slot_init_defaults(&t->slots[i]);
    t->slots[1].channel = 2;
    t->active_slot = 0;

    /* Shared clock defaults. */
    t->bpm = 120.0f;
    t->sync = 0;
    /* Don't self-play on load. Wait for 0xFA/0xFB from the host transport,
     * or mark as running if transport is already playing when we come up. */
    t->running = 0;
    if (t->host && t->host->get_clock_status) {
        if (t->host->get_clock_status() == MOVE_CLOCK_STATUS_RUNNING) {
            t->running = 1;
        }
    }
    t->follow_transport = 1;  /* default: follow Move's transport */
    t->prev_clock_status = MOVE_CLOCK_STATUS_UNAVAILABLE;

    /* Restore persisted state before generating a pattern — if we load a
     * pattern from disk we don't want to overwrite it with a fresh random one.
     * (Task 6: v2 format will load both slots; for now only slot 0 loads.) */
    int loaded = tb3po_load_state(t);

    recompute_step_length(t);
    if (!loaded) {
        /* No saved state — seed each slot's default pattern so there's
         * something to hear as soon as the user switches to it. */
        for (int i = 0; i < NUM_SLOTS; i++) {
            generate_pattern(&t->slots[i], t->slots[i].seed);
        }
    } else {
        /* Slot 1 always cold-starts until Task 6 persists it. */
        generate_pattern(&t->slots[1], t->slots[1].seed);
    }
    for (int i = 0; i < NUM_SLOTS; i++) {
        t->slots[i].position = t->slots[i].length - 1;  /* reset regardless */
    }

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
    /* Release any hanging note + portamento state on every slot. */
    for (int i = 0; i < NUM_SLOTS; i++) {
        tb3po_slot_t *s = &t->slots[i];
        kill_last_note(t, s);
        if (s->portamento_on) {
            uint8_t ch = (uint8_t)((s->channel - 1) & 0x0F);
            send_midi(t, 0xB0 | ch, 65, 0);
            send_midi(t, 0xB0 | ch, 123, 0);
            s->portamento_on = 0;
        }
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
            if (t->clock_pulses == 0) advance_all_slots(t);
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
            /* Transport restart zeroes every slot's cursor so they line up
             * on the downbeat together (subject to each slot's own length). */
            for (int i = 0; i < NUM_SLOTS; i++) {
                t->slots[i].position = t->slots[i].length - 1;  /* next advance lands on 0 */
            }
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
            for (int i = 0; i < NUM_SLOTS; i++) {
                tb3po_slot_t *s = &t->slots[i];
                kill_last_note(t, s);
                if (s->portamento_on) {
                    uint8_t ch = (uint8_t)((s->channel - 1) & 0x0F);
                    send_midi(t, 0xB0 | ch, 65, 0);
                    s->portamento_on = 0;
                }
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

/* Strip an optional per-slot prefix (e.g. "a.density" -> "density") and
 * report which slot was addressed. "a." -> 0, "b." -> 1. Unprefixed keys
 * are treated as slot 0 for back-compat with global params whose dispatch
 * doesn't care about the slot index anyway. */
static const char *strip_slot_prefix(const char *key, int *slot_out) {
    if (key && key[0] == 'a' && key[1] == '.') {
        if (slot_out) *slot_out = 0;
        return key + 2;
    }
    if (key && key[0] == 'b' && key[1] == '.') {
        if (slot_out) *slot_out = 1;
        return key + 2;
    }
    if (slot_out) *slot_out = 0;
    return key;
}

static void tb3po_set_param(void *inst, const char *key, const char *val) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t || !key) return;
    int slot_idx = 0;
    key = strip_slot_prefix(key, &slot_idx);
    if (slot_idx < 0 || slot_idx >= NUM_SLOTS) slot_idx = 0;
    tb3po_slot_t *s = &t->slots[slot_idx];

    /* Global params first — these don't live on the slot struct. */
    if (strcmp(key, "bpm") == 0)          { t->bpm = parse_float(val, 120.0f); if (t->bpm < 20.0f) t->bpm = 20.0f; if (t->bpm > 400.0f) t->bpm = 400.0f; recompute_step_length(t); }
    else if (strcmp(key, "sync") == 0)    t->sync = parse_int(val, 0) ? 1 : 0;
    else if (strcmp(key, "running") == 0) {
        int r = parse_int(val, 1) ? 1 : 0;
        if (!r && t->running) {
            for (int i = 0; i < NUM_SLOTS; i++) kill_last_note(t, &t->slots[i]);
        }
        t->running = r;
    }
    else if (strcmp(key, "follow_transport") == 0) {
        t->follow_transport = parse_int(val, 1) ? 1 : 0;
    }
    else if (strcmp(key, "active_slot") == 0) {
        int v = parse_int(val, 0);
        if (v < 0) v = 0;
        if (v >= NUM_SLOTS) v = NUM_SLOTS - 1;
        t->active_slot = v;
    }
    /* Per-slot params. */
    else if (strcmp(key, "density") == 0)      s->density = parse_float(val, 0.7f);
    else if (strcmp(key, "accent") == 0)  s->accent = parse_float(val, 0.4f);
    else if (strcmp(key, "slide") == 0)   s->slide = parse_float(val, 0.25f);
    else if (strcmp(key, "octaves") == 0) { s->octave_range = parse_int(val, 2); if (s->octave_range < 1) s->octave_range = 1; if (s->octave_range > 3) s->octave_range = 3; }
    else if (strcmp(key, "root") == 0)    { s->root = parse_int(val, 9) % 12; if (s->root < 0) s->root += 12; }
    else if (strcmp(key, "scale") == 0)   { s->scale = parse_int(val, 0); if (s->scale < 0 || s->scale >= NUM_SCALES) s->scale = 0; }
    else if (strcmp(key, "length") == 0)  { int v = parse_int(val, 16); if (v < 2) v = 2; if (v > MAX_STEPS) v = MAX_STEPS; s->length = v; if (s->position >= v) s->position = v - 1; }
    else if (strcmp(key, "gate") == 0)    { s->gate = parse_float(val, 0.5f); if (s->gate < 0.05f) s->gate = 0.05f; if (s->gate > 1.0f) s->gate = 1.0f; }
    else if (strcmp(key, "channel") == 0) { int c = parse_int(val, 1); if (c < 1) c = 1; if (c > 16) c = 16; s->channel = c; }
    else if (strcmp(key, "transpose") == 0) { int sv = parse_int(val, 0); if (sv < -48) sv = -48; if (sv > 48) sv = 48; s->transpose = sv; }
    else if (strcmp(key, "direction") == 0) s->direction = parse_int(val, 0) & 3;
    /* generate/regen/seed rewrite the pattern in place — keep the current
     * playhead so the sequence stays bar-aligned with whatever other tracks
     * the user is running against Move's transport. Otherwise pressing NEW
     * mid-bar snapped us back to step 0 and knocked tb3po out of phase. */
    else if (strcmp(key, "seed") == 0)    { s->seed = (uint32_t)parse_int(val, 0xBEEF); generate_pattern(s, s->seed); }
    else if (strcmp(key, "generate") == 0) { snapshot_undo(s); s->seed = rng_next_u32(s); generate_pattern(s, s->seed); }
    else if (strcmp(key, "regen") == 0)    { snapshot_undo(s); generate_pattern(s, s->seed); }
    else if (strcmp(key, "mutate") == 0)   { snapshot_undo(s); mutate_pattern(s); }
    else if (strcmp(key, "clear") == 0)    { snapshot_undo(s); for (int i = 0; i < MAX_STEPS; i++) s->steps[i] = STEP_REST; s->steps[0] = STEP_NOTE; }
    else if (strcmp(key, "undo") == 0)     restore_undo(s);
    else if (strcmp(key, "store_bank") == 0) {
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS) {
            memcpy(s->bank_steps[b], s->steps, MAX_STEPS);
            memcpy(s->bank_degrees[b], s->degrees, MAX_STEPS);
            memcpy(s->bank_octaves[b], s->octaves, MAX_STEPS);
            s->bank_filled[b] = 1;
            s->current_bank = b;
        }
    }
    else if (strcmp(key, "recall_bank") == 0) {
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS && s->bank_filled[b]) {
            /* Queue the recall. It will apply on the next bar boundary inside
             * advance_step so pattern switches line up musically. */
            s->pending_recall = b;
        }
    }
    else if (strcmp(key, "recall_bank_now") == 0) {
        /* Escape hatch: apply immediately (e.g. when transport is stopped and
         * there's no bar boundary coming). */
        int b = parse_int(val, 0);
        if (b >= 0 && b < NUM_BANKS && s->bank_filled[b]) {
            memcpy(s->steps, s->bank_steps[b], MAX_STEPS);
            memcpy(s->degrees, s->bank_degrees[b], MAX_STEPS);
            memcpy(s->octaves, s->bank_octaves[b], MAX_STEPS);
            s->current_bank = b;
            s->pending_recall = -1;
        }
    }
    else if (strcmp(key, "set_step") == 0) {
        /* format: "idx:kind[:degree:octave]" */
        if (!val) return;
        int idx = 0, kind = STEP_REST, deg = 0, oct = 0;
        int n = sscanf(val, "%d:%d:%d:%d", &idx, &kind, &deg, &oct);
        if (n >= 2 && idx >= 0 && idx < MAX_STEPS) {
            s->steps[idx] = (uint8_t)(kind & 3);
            if (n >= 3) s->degrees[idx] = (uint8_t)deg;
            if (n >= 4) s->octaves[idx] = (uint8_t)oct;
            if (t->host && t->host->log) {
                char m[80]; snprintf(m, sizeof(m), "tb3po set_step slot=%d idx=%d kind=%d", slot_idx, idx, kind);
                t->host->log(m);
            }
        }
    }

    /* Any set_param that lands here changed persisted (or paranoid-safe to
     * resave) state. Mark dirty — render_block will flush the file a few
     * seconds later, batching rapid edits into a single write. */
    t->state_dirty = 1;
}

static int tb3po_get_param(void *inst, const char *key, char *buf, int buf_len) {
    tb3po_inst_t *t = (tb3po_inst_t *)inst;
    if (!t || !key || !buf || buf_len < 2) return -1;
    int slot_idx = 0;
    key = strip_slot_prefix(key, &slot_idx);
    if (slot_idx < 0 || slot_idx >= NUM_SLOTS) slot_idx = 0;
    tb3po_slot_t *s = &t->slots[slot_idx];
    int n = 0;
    /* Global keys first. */
    if (strcmp(key, "bpm") == 0)             n = snprintf(buf, buf_len, "%.1f", t->bpm);
    else if (strcmp(key, "sync") == 0)       n = snprintf(buf, buf_len, "%d", t->sync);
    else if (strcmp(key, "running") == 0)    n = snprintf(buf, buf_len, "%d", t->running ? 1 : 0);
    else if (strcmp(key, "follow_transport") == 0) n = snprintf(buf, buf_len, "%d", t->follow_transport ? 1 : 0);
    else if (strcmp(key, "clock_status") == 0) n = snprintf(buf, buf_len, "%d", t->host_clock_status);
    else if (strcmp(key, "sync_source") == 0) n = snprintf(buf, buf_len, "%s", t->pulse_sync_active ? "EXT" : "INT");
    else if (strcmp(key, "active_slot") == 0) n = snprintf(buf, buf_len, "%d", t->active_slot);
    /* Per-slot keys. */
    else if (strcmp(key, "position") == 0)        n = snprintf(buf, buf_len, "%d", s->ui_current_step);
    else if (strcmp(key, "length") == 0)     n = snprintf(buf, buf_len, "%d", s->length);
    else if (strcmp(key, "density") == 0)    n = snprintf(buf, buf_len, "%.3f", s->density);
    else if (strcmp(key, "accent") == 0)     n = snprintf(buf, buf_len, "%.3f", s->accent);
    else if (strcmp(key, "slide") == 0)      n = snprintf(buf, buf_len, "%.3f", s->slide);
    else if (strcmp(key, "octaves") == 0)    n = snprintf(buf, buf_len, "%d", s->octave_range);
    else if (strcmp(key, "root") == 0)       n = snprintf(buf, buf_len, "%d", s->root);
    else if (strcmp(key, "scale") == 0)      n = snprintf(buf, buf_len, "%d", s->scale);
    else if (strcmp(key, "gate") == 0)       n = snprintf(buf, buf_len, "%.3f", s->gate);
    else if (strcmp(key, "channel") == 0)    n = snprintf(buf, buf_len, "%d", s->channel);
    else if (strcmp(key, "transpose") == 0)  n = snprintf(buf, buf_len, "%d", s->transpose);
    else if (strcmp(key, "direction") == 0)  n = snprintf(buf, buf_len, "%d", s->direction);
    else if (strcmp(key, "seed") == 0)       n = snprintf(buf, buf_len, "%u", (unsigned)s->seed);
    else if (strcmp(key, "current_bank") == 0) n = snprintf(buf, buf_len, "%d", s->current_bank);
    else if (strcmp(key, "pending_recall") == 0) n = snprintf(buf, buf_len, "%d", s->pending_recall);
    else if (strcmp(key, "bank_filled") == 0) {
        int off = 0;
        for (int i = 0; i < NUM_BANKS && off < buf_len - 1; i++) {
            buf[off++] = s->bank_filled[i] ? '1' : '0';
        }
        buf[off] = '\0';
        n = off;
    }
    else if (strcmp(key, "pattern") == 0) {
        /* Compact row: "len|steps|degs|octs" — pipe-separated, each is comma-separated ints. */
        int off = 0;
        off += snprintf(buf + off, buf_len - off, "%d|", s->length);
        for (int i = 0; i < s->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", s->steps[i]);
        if (off < buf_len - 2) off += snprintf(buf + off, buf_len - off, "|");
        for (int i = 0; i < s->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", s->degrees[i]);
        if (off < buf_len - 2) off += snprintf(buf + off, buf_len - off, "|");
        for (int i = 0; i < s->length && off < buf_len - 2; i++)
            off += snprintf(buf + off, buf_len - off, "%s%d", i ? "," : "", s->octaves[i]);
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
            advance_all_slots(t);
        }
    }

    /* Gate off after gate_samples_remaining elapses, unless next step is slide.
     * Runs per-slot so each has its own hold time (their gate params are
     * independent). Slot 1 has no outstanding notes in Task 3 because it
     * never fires emit_step, but running the gate accounting is harmless. */
    for (int i = 0; i < NUM_SLOTS; i++) {
        tb3po_slot_t *s = &t->slots[i];
        if (s->gate_samples_remaining > 0) {
            s->gate_samples_remaining -= frames;
            if (s->gate_samples_remaining <= 0) {
                s->gate_samples_remaining = 0;
                /* Only release if the CURRENT step isn't slide (slide = hold until next note). */
                if (s->steps[s->position] != STEP_SLIDE) kill_last_note(t, s);
            }
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
