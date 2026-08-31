/*
 * Bank persistence unit test — compiled natively, no device.
 *
 * tb3po.c is INCLUDED rather than linked so the test can reach the slot
 * struct directly and so the state-file path macros can be overridden on the
 * command line (see the Makefile). There is no shared object to build and no
 * dlopen: the plugin's own v2 entry points are called in-process, which is
 * exactly how the host calls them.
 *
 * The v2 blob is written HERE, by hand, rather than by the production writer.
 * That is the whole point of a migration test: a fixture produced by the code
 * under test cannot prove the code reads what the OLD code wrote.
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../src/dsp/tb3po.c"

static int failures = 0;
#define CHECK(cond, ...) do { \
    if (!(cond)) { \
        failures++; \
        fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
        fprintf(stderr, __VA_ARGS__); \
        fprintf(stderr, "\n"); \
    } \
} while (0)

static void wipe_state_file(void) { unlink(TB3PO_STATE_PATH); }

static plugin_api_v2_t *api(void) { return move_plugin_init_v2(NULL); }

static void set(void *t, const char *k, const char *v) { api()->set_param(t, k, v); }
static const char *get(void *t, const char *k) {
    static char buf[4096];
    buf[0] = '\0';
    int n = api()->get_param(t, k, buf, sizeof(buf));
    if (n < 0) return "";
    return buf;
}
static int get_i(void *t, const char *k) { return atoi(get(t, k)); }

/* ------------------------------------------------------------------ */
/* 1. The reported bug: length is part of a pattern, so a recall must
 *    bring it back.                                                    */
/* ------------------------------------------------------------------ */
static void test_recall_now_restores_length(void) {
    wipe_state_file();
    void *t = api()->create_instance(NULL, NULL);
    assert(t);

    set(t, "a.length", "32");
    set(t, "a.set_step", "31:1:5:1");     /* a note only a 32-step pattern has */
    set(t, "a.store_bank", "0");

    set(t, "a.length", "16");
    CHECK(get_i(t, "a.length") == 16, "precondition: length should be 16, got %d", get_i(t, "a.length"));

    set(t, "a.recall_bank_now", "0");
    CHECK(get_i(t, "a.length") == 32,
          "recall_bank_now must restore the bank's length: expected 32, got %d", get_i(t, "a.length"));

    tb3po_slot_t *s = &((tb3po_inst_t *)t)->slots[0];
    CHECK(s->steps[31] == STEP_NOTE, "step 31 should have survived the recall, got %d", s->steps[31]);

    api()->destroy_instance(t);
    printf("  test_recall_now_restores_length done\n");
}

/* ------------------------------------------------------------------ */
/* 2. The QUEUED recall (transport running) applies at the bar boundary
 *    and must restore the length there too.                            */
/* ------------------------------------------------------------------ */
static void test_queued_recall_restores_length(void) {
    wipe_state_file();
    void *t = api()->create_instance(NULL, NULL);
    assert(t);

    set(t, "a.length", "8");
    set(t, "a.store_bank", "1");
    set(t, "a.length", "24");

    /* Start the transport and clock it by hand: 0xFA then 0xF8 pulses,
     * six per 16th, which is how the shim drives it. */
    uint8_t start = 0xFA, tick = 0xF8;
    api()->on_midi(t, &start, 1, 0);

    set(t, "a.recall_bank", "1");
    CHECK(get_i(t, "a.pending_recall") == 1, "recall should be QUEUED while running, got %d",
          get_i(t, "a.pending_recall"));
    CHECK(get_i(t, "a.length") == 24, "queued recall must not apply early, got %d", get_i(t, "a.length"));

    /* One full 24-step lap is 24*6 pulses; give it two laps of headroom. */
    for (int i = 0; i < 24 * 6 * 2 && get_i(t, "a.pending_recall") >= 0; i++) {
        api()->on_midi(t, &tick, 1, 0);
    }
    CHECK(get_i(t, "a.pending_recall") == -1, "queued recall never applied");
    CHECK(get_i(t, "a.length") == 8,
          "queued recall must restore the bank's length: expected 8, got %d", get_i(t, "a.length"));

    tb3po_slot_t *s = &((tb3po_inst_t *)t)->slots[0];
    CHECK(s->position < s->length, "playhead must be inside the recalled length: pos=%d len=%d",
          s->position, s->length);

    api()->destroy_instance(t);
    printf("  test_queued_recall_restores_length done\n");
}

/* ------------------------------------------------------------------ */
/* v2 fixture writer — a byte-for-byte copy of the OLD write_slot_blob. */
/* ------------------------------------------------------------------ */
typedef struct {
    int32_t length, direction;
    float density, accent, slide;
    int32_t octave_range, root, scale;
    float bpm, gate;
    int32_t channel, transpose;
    uint32_t seed;
    int32_t current_bank;
    uint8_t steps[MAX_STEPS], degrees[MAX_STEPS], octaves[MAX_STEPS];
    uint8_t bank_steps[NUM_BANKS][MAX_STEPS];
    uint8_t bank_degrees[NUM_BANKS][MAX_STEPS];
    uint8_t bank_octaves[NUM_BANKS][MAX_STEPS];
    uint8_t bank_filled[NUM_BANKS];
} v2_slot_t;

static void v2_write_slot(FILE *f, const v2_slot_t *v) {
    fwrite(&v->length, 4, 1, f);       fwrite(&v->direction, 4, 1, f);
    fwrite(&v->density, 4, 1, f);      fwrite(&v->accent, 4, 1, f);
    fwrite(&v->slide, 4, 1, f);        fwrite(&v->octave_range, 4, 1, f);
    fwrite(&v->root, 4, 1, f);         fwrite(&v->scale, 4, 1, f);
    fwrite(&v->bpm, 4, 1, f);          fwrite(&v->gate, 4, 1, f);
    fwrite(&v->channel, 4, 1, f);      fwrite(&v->transpose, 4, 1, f);
    fwrite(&v->seed, 4, 1, f);         fwrite(&v->current_bank, 4, 1, f);
    fwrite(v->steps, 1, MAX_STEPS, f);
    fwrite(v->degrees, 1, MAX_STEPS, f);
    fwrite(v->octaves, 1, MAX_STEPS, f);
    for (int b = 0; b < NUM_BANKS; b++) {
        fwrite(v->bank_steps[b], 1, MAX_STEPS, f);
        fwrite(v->bank_degrees[b], 1, MAX_STEPS, f);
        fwrite(v->bank_octaves[b], 1, MAX_STEPS, f);
    }
    fwrite(v->bank_filled, 1, NUM_BANKS, f);
}

static void v2_fill_defaults(v2_slot_t *v, int length, int channel) {
    memset(v, 0, sizeof(*v));
    v->length = length; v->direction = 0;
    v->density = 0.7f; v->accent = 0.4f; v->slide = 0.25f;
    v->octave_range = 2; v->root = 9; v->scale = 0;
    v->bpm = 137.0f; v->gate = 0.5f;
    v->channel = channel; v->transpose = 0;
    v->seed = 0xBEEF; v->current_bank = 0;
}

/* ------------------------------------------------------------------ */
/* 3. A v2 file must LOAD, not be discarded, and every bank must come
 *    back with a usable length.                                        */
/* ------------------------------------------------------------------ */
static void test_v2_migration(void) {
    wipe_state_file();
    ensure_state_dir();

    v2_slot_t a, b;
    v2_fill_defaults(&a, 12, 1);
    v2_fill_defaults(&b, 20, 2);

    /* Fill banks 0 and 3 on slot A with recognisable note data. */
    for (int i = 0; i < MAX_STEPS; i++) {
        a.bank_steps[0][i]   = (uint8_t)(i % 4);
        a.bank_degrees[0][i] = (uint8_t)(i % 7);
        a.bank_octaves[0][i] = (uint8_t)(i % 3);
        a.bank_steps[3][i]   = (uint8_t)((i + 1) % 4);
    }
    a.bank_filled[0] = 1;
    a.bank_filled[3] = 1;
    a.steps[0] = STEP_ACCENT;
    b.bank_filled[7] = 1;
    for (int i = 0; i < MAX_STEPS; i++) b.bank_steps[7][i] = (uint8_t)((i + 2) % 4);

    FILE *f = fopen(TB3PO_STATE_PATH, "wb");
    assert(f);
    uint32_t magic = TB3PO_STATE_MAGIC, ver = 2u;
    uint8_t active = 1;
    fwrite(&magic, 4, 1, f); fwrite(&ver, 4, 1, f); fwrite(&active, 1, 1, f);
    v2_write_slot(f, &a);
    v2_write_slot(f, &b);
    fclose(f);

    void *t = api()->create_instance(NULL, NULL);
    assert(t);
    tb3po_inst_t *inst = (tb3po_inst_t *)t;

    /* The file must have been ACCEPTED, not silently cold-started. */
    CHECK(inst->slots[0].length == 12, "v2 slot A length lost: got %d", inst->slots[0].length);
    CHECK(inst->slots[1].length == 20, "v2 slot B length lost: got %d", inst->slots[1].length);
    CHECK(inst->active_slot == 1, "v2 active_slot lost: got %d", inst->active_slot);
    CHECK(inst->bpm > 136.9f && inst->bpm < 137.1f, "v2 bpm lost: got %f", (double)inst->bpm);
    CHECK(inst->slots[0].steps[0] == STEP_ACCENT, "v2 live pattern lost");
    CHECK(inst->slots[0].bank_filled[0] == 1 && inst->slots[0].bank_filled[3] == 1,
          "v2 bank_filled lost");

    /* Note data intact. */
    for (int i = 0; i < MAX_STEPS; i++) {
        CHECK(inst->slots[0].bank_steps[0][i] == (uint8_t)(i % 4), "v2 bank 0 steps[%d] wrong", i);
        CHECK(inst->slots[0].bank_degrees[0][i] == (uint8_t)(i % 7), "v2 bank 0 degrees[%d] wrong", i);
        CHECK(inst->slots[0].bank_octaves[0][i] == (uint8_t)(i % 3), "v2 bank 0 octaves[%d] wrong", i);
    }
    CHECK(inst->slots[1].bank_steps[7][5] == (uint8_t)(7 % 4), "v2 slot B bank 7 steps wrong");

    /* Every bank — filled or not — must carry a length a sequencer can run.
     * A zero here is a pattern that never advances (and a %0 in
     * next_position). The best answer available for a v2 file is the slot's
     * own length, which is what those banks actually played. */
    for (int b2 = 0; b2 < NUM_BANKS; b2++) {
        CHECK(inst->slots[0].bank_lengths[b2] == 12,
              "v2 slot A bank %d length should be seeded from the slot (12), got %d",
              b2, inst->slots[0].bank_lengths[b2]);
        CHECK(inst->slots[1].bank_lengths[b2] == 20,
              "v2 slot B bank %d length should be seeded from the slot (20), got %d",
              b2, inst->slots[1].bank_lengths[b2]);
    }

    /* And the migrated bank must actually recall at that length. */
    set(t, "a.length", "4");
    set(t, "a.recall_bank_now", "0");
    CHECK(get_i(t, "a.length") == 12, "migrated bank recalled at %d, expected 12", get_i(t, "a.length"));

    api()->destroy_instance(t);
    printf("  test_v2_migration done\n");
}

/* ------------------------------------------------------------------ */
/* 4. v3 round-trip: what we write, we read back.                       */
/* ------------------------------------------------------------------ */
static void test_v3_roundtrip(void) {
    wipe_state_file();

    void *t = api()->create_instance(NULL, NULL);
    assert(t);
    set(t, "a.length", "32");
    set(t, "a.set_step", "30:2:3:1");
    set(t, "a.store_bank", "2");
    set(t, "a.length", "5");
    set(t, "a.store_bank", "5");
    set(t, "b.length", "9");
    set(t, "b.store_bank", "1");
    set(t, "a.length", "16");
    api()->destroy_instance(t);   /* flushes v3 */

    /* The file on disk must declare v3. */
    FILE *f = fopen(TB3PO_STATE_PATH, "rb");
    assert(f);
    uint32_t magic = 0, ver = 0;
    size_t rd = fread(&magic, 4, 1, f); (void)rd;
    rd = fread(&ver, 4, 1, f);
    fclose(f);
    CHECK(magic == TB3PO_STATE_MAGIC, "magic changed");
    CHECK(ver == 3u, "written version should be 3, got %u", ver);

    void *t2 = api()->create_instance(NULL, NULL);
    assert(t2);
    tb3po_inst_t *inst = (tb3po_inst_t *)t2;
    CHECK(inst->slots[0].length == 16, "v3 slot length lost: got %d", inst->slots[0].length);
    CHECK(inst->slots[0].bank_lengths[2] == 32, "v3 bank 2 length lost: got %d",
          inst->slots[0].bank_lengths[2]);
    CHECK(inst->slots[0].bank_lengths[5] == 5, "v3 bank 5 length lost: got %d",
          inst->slots[0].bank_lengths[5]);
    CHECK(inst->slots[1].bank_lengths[1] == 9, "v3 slot B bank 1 length lost: got %d",
          inst->slots[1].bank_lengths[1]);
    CHECK(inst->slots[0].bank_steps[2][30] == STEP_ACCENT, "v3 bank note data lost");

    set(t2, "a.recall_bank_now", "2");
    CHECK(get_i(t2, "a.length") == 32, "v3 recall after reload gave %d", get_i(t2, "a.length"));
    set(t2, "a.recall_bank_now", "5");
    CHECK(get_i(t2, "a.length") == 5, "v3 recall after reload gave %d", get_i(t2, "a.length"));

    api()->destroy_instance(t2);
    wipe_state_file();
    printf("  test_v3_roundtrip done\n");
}

int main(void) {
    printf("tb3po bank tests (state at %s)\n", TB3PO_STATE_PATH);
    test_recall_now_restores_length();
    test_queued_recall_restores_length();
    test_v2_migration();
    test_v3_roundtrip();
    if (failures) { printf("FAILED: %d check(s)\n", failures); return 1; }
    printf("PASS\n");
    return 0;
}
