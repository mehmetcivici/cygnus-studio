# CyCAN board library: host build, tests, fuzz and the cross-compatibility bridge.
#   make test      build and run the host tests and a short fuzz run (ASan + UBSan when available)
#   make fuzz      full fuzz run: fixed seed, FUZZ_FRAMES random frames (default 200000)
#   make bridge    build/cycan-bridge, the stdin/stdout board for TS cross tests (tools/bridge)
#   make vectors   regenerate test/cycan_vectors.inc from the TypeScript golden vectors
#   make clean

CC      ?= gcc
PYTHON  ?= python3
BUILD   := build
VECTORS_JSON := ../../packages/protocol/test/vectors/cycan-vectors.json
FUZZ_FRAMES ?= 200000
FUZZ_SEED   ?= 1
FUZZ_SHORT  ?= 20000

CFLAGS_BASE := -std=c99 -Wall -Wextra -Werror -pedantic -Wconversion -O1 -g -Iinclude -Itest
# Extra strictness for the library itself (it must also build cleanly for Cortex-M).
LIB_WARN := -Wshadow -Wcast-align -Wstrict-prototypes -Wmissing-prototypes

SAN := $(shell printf 'int main(void){return 0;}' | $(CC) -x c -fsanitize=address,undefined -o /dev/null - >/dev/null 2>&1 && echo -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)

LIB_SRC  := src/cycan_codec.c src/cycan_store.c src/cycan_node.c src/cycan_boot.c
TEST_SRC := test/test_main.c test/fake.c test/test_codec.c test/test_node.c test/test_boot.c
HEADERS  := $(wildcard include/*.h) $(wildcard test/*.h) test/cycan_vectors.inc

LIB_OBJ    := $(LIB_SRC:src/%.c=$(BUILD)/lib_%.o)
TEST_OBJ   := $(TEST_SRC:test/%.c=$(BUILD)/test_%.o)
BRIDGE_OBJ := $(LIB_SRC:src/%.c=$(BUILD)/bridge_%.o)

.PHONY: test fuzz bridge vectors clean

test: $(BUILD)/cycan_tests $(BUILD)/cycan_fuzz
	./$(BUILD)/cycan_tests
	./$(BUILD)/cycan_fuzz $(FUZZ_SHORT) $(FUZZ_SEED)

fuzz: $(BUILD)/cycan_fuzz
	./$(BUILD)/cycan_fuzz $(FUZZ_FRAMES) $(FUZZ_SEED)

bridge: $(BUILD)/cycan-bridge

$(BUILD)/cycan_tests: $(LIB_OBJ) $(TEST_OBJ)
	$(CC) $(SAN) -o $@ $^ -lm

$(BUILD)/cycan_fuzz: $(LIB_OBJ) $(BUILD)/test_fake.o $(BUILD)/test_fuzz.o
	$(CC) $(SAN) -o $@ $^ -lm

# The bridge is a tool, not a test: optimized, no sanitizers.
$(BUILD)/cycan-bridge: $(BRIDGE_OBJ) $(BUILD)/bridge_main.o
	$(CC) -o $@ $^

$(BUILD)/lib_%.o: src/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(LIB_WARN) $(SAN) -c $< -o $@

$(BUILD)/test_%.o: test/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(SAN) -c $< -o $@

$(BUILD)/bridge_%.o: src/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(LIB_WARN) -O2 -c $< -o $@

$(BUILD)/bridge_main.o: tools/bridge/cycan_bridge.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(LIB_WARN) -O2 -c $< -o $@

$(BUILD):
	mkdir -p $@

vectors: $(VECTORS_JSON) test/gen_vectors.py
	$(PYTHON) test/gen_vectors.py $(VECTORS_JSON) test/cycan_vectors.inc

clean:
	rm -rf $(BUILD)
