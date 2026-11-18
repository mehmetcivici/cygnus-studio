/*
 * Cyncoder bootloader on CyCAN (flash 0x08000000..0x08003FFF). Reference skeleton.
 *
 * Image area: pages 8..61 (0x08004000, 108 KB). The .cyfw header sits at 0x08004000; the
 * application is linked at 0x08004040 with its vector table aligned up to 0x08004200.
 */
#include <string.h>

#include "cycan.h"
#include "cycan_boot.h"
#include "cycan_port_stm32g4.h"
#include "stm32g4xx_hal.h"

#define IMAGE_BASE 0x08004000ul
#define IMAGE_FIRST_PAGE 8u
#define IMAGE_PAGES 54u
#define APP_VECTORS 0x08004200ul

extern FDCAN_HandleTypeDef hfdcan1;

/* CAN, UID and the identity page are shared with the application's port. */
static bool bl_send(void *ctx, const cycan_frame_t *f)
{
    return g_port_hal.can_send(ctx, f);
}

static void bl_uid(void *ctx, uint8_t out[12])
{
    g_port_hal.uid96(ctx, out);
}

static bool bl_erase(void *ctx, uint32_t size)
{
    FLASH_EraseInitTypeDef e;
    uint32_t err;
    HAL_StatusTypeDef st;
    (void)ctx;
    e.TypeErase = FLASH_TYPEERASE_PAGES;
    e.Banks = FLASH_BANK_1;
    e.Page = IMAGE_FIRST_PAGE;
    e.NbPages = (size + PORT_FLASH_PAGE_SIZE - 1u) / PORT_FLASH_PAGE_SIZE;
    HAL_FLASH_Unlock();
    st = HAL_FLASHEx_Erase(&e, &err);
    HAL_FLASH_Lock();
    return st == HAL_OK;
}

static bool bl_write(void *ctx, uint32_t off, const uint8_t *data, uint32_t len)
{
    uint32_t i;
    bool ok = true;
    (void)ctx;
    HAL_FLASH_Unlock();
    for (i = 0; i < len && ok; i += 8u) {
        uint64_t dw;
        memcpy(&dw, data + i, 8);
        ok = HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD, IMAGE_BASE + off + i, dw) == HAL_OK;
    }
    HAL_FLASH_Lock();
    return ok;
}

static bool bl_read(void *ctx, uint32_t off, uint8_t *data, uint32_t len)
{
    (void)ctx;
    memcpy(data, (const void *)(IMAGE_BASE + off), len);
    return true;
}

static void jump_to_app(void)
{
    const uint32_t *vt = (const uint32_t *)APP_VECTORS;
    HAL_FDCAN_Stop(&hfdcan1);
    HAL_RCC_DeInit();
    HAL_DeInit();
    SysTick->CTRL = 0;
    SCB->VTOR = APP_VECTORS;
    __set_MSP(vt[0]);
    ((void (*)(void))vt[1])();
}

static void bl_start_app(void *ctx)
{
    (void)ctx;
    g_port_boot_request = 0;
    NVIC_SystemReset(); /* clean peripheral state; the reset path below jumps */
}

static bool bl_identity_save(void *ctx, uint8_t num)
{
    uint8_t rec[CYCAN_IDENTITY_SIZE];
    cycan_identity_encode(rec, num);
    return g_port_hal.storage_erase(ctx, CYCAN_REGION_IDENTITY) &&
           g_port_hal.storage_write(ctx, CYCAN_REGION_IDENTITY, 0, rec, sizeof rec);
}

static const cycan_boot_hal_t k_bl_hal = {
    NULL, bl_send, bl_uid, IMAGE_PAGES * PORT_FLASH_PAGE_SIZE, bl_erase, bl_write, bl_read,
    bl_start_app, NULL, NULL, bl_identity_save,
};

static cycan_boot_t g_bl;

void bootloader_main(void)
{
    cycan_boot_cfg_t cfg;
    uint8_t rec[CYCAN_IDENTITY_SIZE];
    memcpy(rec, (const void *)PORT_PAGE_ADDR(PORT_IDENTITY_PAGE), sizeof rec);
    cfg.model = CYCAN_MODEL_CYNCODER;
    cfg.devtype = CYCAN_CYNCODER_DEVTYPE;
    cfg.hw_rev = 2;
    cfg.bootloader_ver = 1;
    cfg.catalog_rev = CYCAN_CYNCODER_CATALOG_REV;
    cfg.num = cycan_identity_decode(rec);
    cfg.window = 0;
    cycan_boot_init(&g_bl, &cfg, &k_bl_hal, port_now_us());

    /* Normal reset with a valid image: start it at once. */
    if (g_port_boot_request != PORT_BOOT_MAGIC && cycan_boot_image_valid(&g_bl)) jump_to_app();
    g_port_boot_request = 0;

    /* The bootloader has no RX interrupt: frames are pulled here and fed in order. */
    port_can_start(1); /* FD 2 Mbit/s data phase: 61-byte chunks */
    for (;;) {
        FDCAN_RxHeaderTypeDef h;
        uint8_t buf[64];
        while (HAL_FDCAN_GetRxFifoFillLevel(&hfdcan1, FDCAN_RX_FIFO0) > 0u &&
               HAL_FDCAN_GetRxMessage(&hfdcan1, FDCAN_RX_FIFO0, &h, buf) == HAL_OK) {
            if (h.IdType != FDCAN_EXTENDED_ID) continue;
            (void)cycan_boot_on_frame(&g_bl, h.Identifier, buf, port_dlc_to_len(h.DataLength));
            cycan_boot_poll(&g_bl, port_now_us());
        }
        cycan_boot_poll(&g_bl, port_now_us());
    }
}
