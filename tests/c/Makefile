# Native (host) unit tests for the TB-3PO DSP.
#
# tb3po.c is compiled INTO the test rather than dlopen'd: no cross-toolchain,
# no device, and the test can override the state-file path so it never touches
# /data/UserData. Mirrors schwung's own tests/host pattern.

CC      ?= cc
BUILD   := build
STATE   := $(abspath $(BUILD)/state)
CFLAGS  += -std=c11 -g -O0 -Wall -Wno-unused-function \
           -DTB3PO_STATE_DIR='"$(STATE)"' \
           -DTB3PO_STATE_PATH='"$(STATE)/tb3po.bin"'
LDFLAGS += -lpthread

TESTS := $(BUILD)/test_banks

.PHONY: test clean
test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; $$t || exit 1; done

$(BUILD)/test_banks: test_banks.c ../../src/dsp/tb3po.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ test_banks.c $(LDFLAGS)

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
