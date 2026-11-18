/* Fake HAL + host side helpers for the node and bootloader tests. */
#ifndef CYCAN_FAKE_H
#define CYCAN_FAKE_H

#include "cycan.h"
#include "cycan_boot.h"

#define FAKE_MAX_SENT 4096
#define FAKE_REGION_SIZE 1024u
#define FAKE_FLASH_SIZE 8192u

typedef struct {
    cycan_frame_t sent[FAKE_MAX_SENT];
    int nsent;
    int send_fail;      /* number of next can_send calls that fail */
    uint8_t uid96[12];
    uint8_t region[2][FAKE_REGION_SIZE]; /* storage slots A and B */
    int erases, writes;
    int nsent_at_store; /* frames already sent when storage was last written */
    /* Power-cut injection: < 0 off; otherwise the number of bytes that may still be
     * programmed. An erase with 0 left is torn (half the slot erased); the write that runs
     * out programs only the bytes left. Afterwards every storage call fails (dead). */
    long cut_budget;
    bool dead;
    long programmed; /* bytes programmed since fake_init / last reset of this counter */
    int can_configs;
    uint8_t can_bitrate;
    int reboots, bootloaders, app_starts;
    int led_calls;
    bool led;
    uint32_t rnd;
    uint8_t flash[FAKE_FLASH_SIZE];
    bool flash_fail;
    cycan_hal_t hal;
    cycan_boot_hal_t boot_hal;
} fake_t;

/* Fresh fake with erased storage and the given UID seed. */
void fake_init(fake_t *f, uint8_t uid_seed);
void fake_clear(fake_t *f);
/* Number of sent frames with the given class/index (index 0xFF = any). */
int fake_count(const fake_t *f, uint8_t cls, uint8_t index);
/* The n-th sent frame with that class/index, or NULL. */
const cycan_frame_t *fake_find(const fake_t *f, uint8_t cls, uint8_t index, int n);
const cycan_frame_t *fake_last(const fake_t *f, uint8_t cls, uint8_t index);

/* Delivers a host frame to the node / bootloader. */
void to_node(cycan_node_t *n, const cycan_frame_t *fr);
void to_boot(cycan_boot_t *b, const cycan_frame_t *fr);
/* Polls every 1 ms for `ms` milliseconds. */
void run_ms(cycan_node_t *n, uint32_t *now, uint32_t ms);
void run_boot_ms(cycan_boot_t *b, uint32_t *now, uint32_t ms);

#endif
