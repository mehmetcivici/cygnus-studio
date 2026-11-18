/*
 * STM32G431 port of the CyCAN HAL (STM32Cube HAL, FDCAN1). Reference skeleton: it is not
 * built by the host Makefile; copy it into the board project and adjust pins and clocks.
 *
 * Resources used
 * - FDCAN1, kernel clock 160 MHz (PLLQ), RX FIFO 0 interrupt.
 * - TIM2 (32-bit) free running at 1 MHz: the cycan time base.
 * - Flash page 62 (identity) and page 63 (parameters) of the 128 KB single bank.
 * - A .noinit word that asks the bootloader to stay after a software reset.
 */
#ifndef CYCAN_PORT_STM32G4_H
#define CYCAN_PORT_STM32G4_H

#include "cycan.h"

#define PORT_FLASH_PAGE_SIZE 2048u
#define PORT_IDENTITY_PAGE 62u
#define PORT_PARAMS_PAGE 63u
#define PORT_PAGE_ADDR(p) (0x08000000ul + (uint32_t)(p) * PORT_FLASH_PAGE_SIZE)

/* Shared with the bootloader: a software reset with this value set keeps it in update mode. */
#define PORT_BOOT_MAGIC 0xB007CA75ul
extern volatile uint32_t g_port_boot_request;

extern const cycan_hal_t g_port_hal;

/** Configures FDCAN1 for can.data_bitrate (0 classic, 1 2M, 2 5M, 3 8M) and starts it. */
void port_can_start(uint8_t data_bitrate);
/** Free-running microseconds (TIM2->CNT). */
uint32_t port_now_us(void);
/** HAL FDCAN DataLength code to payload bytes. */
uint8_t port_dlc_to_len(uint32_t hal_dlc);
/** Node the RX interrupt feeds; set before port_can_start(). */
void port_bind_node(cycan_node_t *node);

#endif
