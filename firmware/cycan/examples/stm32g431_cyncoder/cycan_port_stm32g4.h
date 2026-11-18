/*
 * STM32G431 port of the CyCAN HAL (STM32Cube HAL, FDCAN1). Reference skeleton: it is not
 * built by the host Makefile; copy it into the board project and adjust pins and clocks.
 *
 * Resources used
 * - FDCAN1, kernel clock 160 MHz (PLLQ), RX FIFO 0 interrupt.
 * - TIM2 (32-bit) free running at 1 MHz: the cycan time base.
 * - Flash pages 61 and 62 of the 128 KB single bank: the A/B parameter store (cycan_store.h),
 *   shared with the bootloader.
 * - A .noinit word that tells the bootloader why the last software reset happened.
 */
#ifndef CYCAN_PORT_STM32G4_H
#define CYCAN_PORT_STM32G4_H

#include "cycan.h"

#define PORT_FLASH_PAGE_SIZE 2048u
#define PORT_SLOT_A_PAGE 61u
#define PORT_SLOT_B_PAGE 62u
#define PORT_PAGE_ADDR(p) (0x08000000ul + (uint32_t)(p) * PORT_FLASH_PAGE_SIZE)

/* Shared with the bootloader through a software reset:
 * - PORT_BOOT_STAY: ENTER_BOOTLOADER, stay in the bootloader (cfg.stay, no recovery window).
 * - PORT_BOOT_START: the bootloader has just verified the image; jump without re-checking.
 * Anything else (power-up, REBOOT, watchdog): normal start with the recovery window. */
#define PORT_BOOT_STAY 0xB007CA75ul
#define PORT_BOOT_START 0xB0075EA7ul
extern volatile uint32_t g_port_boot_request;

extern const cycan_hal_t g_port_hal;

/* Storage callbacks, also used by the bootloader's HAL. */
bool port_storage_read(void *ctx, uint8_t slot, uint32_t off, void *buf, uint32_t len);
bool port_storage_erase(void *ctx, uint8_t slot);
bool port_storage_write(void *ctx, uint8_t slot, uint32_t off, const void *buf, uint32_t len);
bool port_can_send(void *ctx, const cycan_frame_t *f);
void port_uid96(void *ctx, uint8_t out[12]);
uint32_t port_random(void *ctx);

/** Configures FDCAN1 for can.data_bitrate (0 classic, 1 2M, 2 5M, 3 8M) and starts it. */
void port_can_start(uint8_t data_bitrate);
/** Free-running microseconds (TIM2->CNT). */
uint32_t port_now_us(void);
/** HAL FDCAN DataLength code to payload bytes. */
uint8_t port_dlc_to_len(uint32_t hal_dlc);
/** Node the RX interrupt feeds; set before port_can_start(). */
void port_bind_node(cycan_node_t *node);

#endif
