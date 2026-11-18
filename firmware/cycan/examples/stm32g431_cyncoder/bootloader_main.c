/*
 * Cyncoder bootloader on CyCAN (flash 0x08000000..0x08003FFF). Reference skeleton.
 *
 * Image area: pages 8..60 (0x08004000, 106 KB). The .cyfw header sits at 0x08004000; the
 * application is linked at 0x08004040 with its vector table aligned up to 0x08004200.
 * Pages 61/62 hold the A/B parameter store shared with the application (NUM and
 * can.data_bitrate are read from there by the library).
 */
#include <string.h>

#include "cycan.h"
#include "cycan_boot.h"
#include "cycan_port_stm32g4.h"
#include "stm32g4xx_hal.h"

#define IMAGE_BASE 0x08004000ul
#define IMAGE_FIRST_PAGE 8u
#define IMAGE_PAGES 53u
#define APP_VECTORS 0x08004200ul

extern FDCAN_HandleTypeDef hfdcan1;

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

/* The library has verified the image: reset for clean peripherals and jump straight away
 * (no second recovery window). */
static void bl_start_app(void *ctx)
{
    (void)ctx;
    g_port_boot_request = PORT_BOOT_START;
    NVIC_SystemReset();
}

/* Configures FDCAN with the stored can.data_bitrate (finding 16: not a fixed 2 Mbit/s). */
static void bl_can_config(void *ctx, uint8_t data_bitrate)
{
    (void)ctx;
    port_can_start(data_bitrate);
}

static const cycan_boot_hal_t k_bl_hal = {
    NULL,          port_can_send, port_uid96,  bl_can_config,     IMAGE_PAGES * PORT_FLASH_PAGE_SIZE,
    bl_erase,      bl_write,      bl_read,     bl_start_app,      NULL,
    port_random,   port_storage_read,          port_storage_erase, port_storage_write,
};

static cycan_boot_t g_bl;

void bootloader_main(void)
{
    cycan_boot_cfg_t cfg;
    uint32_t request = g_port_boot_request;
    g_port_boot_request = 0;
    if (request == PORT_BOOT_START) jump_to_app();

    cfg.model = CYCAN_MODEL_CYNCODER;
    cfg.devtype = CYCAN_CYNCODER_DEVTYPE;
    cfg.hw_rev = 2;
    cfg.bootloader_ver = 2;
    cfg.catalog_rev = CYCAN_CYNCODER_CATALOG_REV;
    cfg.window = 0;
    cfg.data_bitrate_default = 1; /* catalog default of can.data_bitrate */
    cfg.stay = request == PORT_BOOT_STAY;
    /* Reads NUM and can.data_bitrate from the store, starts CAN through bl_can_config(),
     * checks the image. With a valid image and no stay request it then listens 150 ms for
     * the recovery broadcast (PROTOCOL 9.0) before calling bl_start_app(). */
    cycan_boot_init(&g_bl, &cfg, &k_bl_hal, port_now_us());

    /* The bootloader has no RX interrupt: frames are pulled here and fed in order, one poll
     * per frame, so its 4-entry ring never overflows. */
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
