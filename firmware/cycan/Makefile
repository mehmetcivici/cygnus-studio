# CyCAN board library: host build and tests.
#   make test      build and run the host tests (ASan + UBSan when the compiler supports them)
#   make vectors   regenerate test/cycan_vectors.inc from the TypeScript golden vectors
#   make clean

CC      ?= gcc
PYTHON  ?= python3
BUILD   := build
VECTORS_JSON := ../../packages/protocol/test/vectors/cycan-vectors.json

CFLAGS_BASE := -std=c99 -Wall -Wextra -Werror -pedantic -O1 -g -Iinclude -Itest
# Extra strictness for the library itself (it must also build cleanly for Cortex-M).
LIB_WARN := -Wshadow -Wconversion -Wcast-align -Wstrict-prototypes -Wmissing-prototypes

SAN := $(shell printf 'int main(void){return 0;}' | $(CC) -x c -fsanitize=address,undefined -o /dev/null - >/dev/null 2>&1 && echo -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)

LIB_SRC  := src/cycan_codec.c src/cycan_node.c src/cycan_boot.c
TEST_SRC := test/test_main.c test/fake.c test/test_codec.c test/test_node.c test/test_boot.c
HEADERS  := $(wildcard include/*.h) $(wildcard test/*.h) test/cycan_vectors.inc

LIB_OBJ  := $(LIB_SRC:src/%.c=$(BUILD)/lib_%.o)
TEST_OBJ := $(TEST_SRC:test/%.c=$(BUILD)/test_%.o)

.PHONY: test vectors clean

test: $(BUILD)/cycan_tests
	./$(BUILD)/cycan_tests

$(BUILD)/cycan_tests: $(LIB_OBJ) $(TEST_OBJ)
	$(CC) $(SAN) -o $@ $^ -lm

$(BUILD)/lib_%.o: src/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(LIB_WARN) $(SAN) -c $< -o $@

$(BUILD)/test_%.o: test/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS_BASE) $(SAN) -c $< -o $@

$(BUILD):
	mkdir -p $@

vectors: $(VECTORS_JSON) test/gen_vectors.py
	$(PYTHON) test/gen_vectors.py $(VECTORS_JSON) test/cycan_vectors.inc

clean:
	rm -rf $(BUILD)
