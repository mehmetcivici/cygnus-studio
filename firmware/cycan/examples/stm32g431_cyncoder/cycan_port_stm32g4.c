/* STM32G431 CyCAN HAL binding (STM32Cube HAL). Reference skeleton, not built on the host. */
#include "cycan_port_stm32g4.h"

#include <string.h>

#include "stm32g4xx_hal.h"

extern FDCAN_HandleTypeDef hfdcan1; /* CubeMX generated, FDCAN kernel clock 160 MHz */

/* Survives a software reset (place in a NOLOAD section in the linker script). */
__attribute__((section(".noinit"))) volatile uint32_t g_port_boot_request;

static cycan_node_t *s_node;

/* HAL DLC constants differ between Cube G4 versions; a table keeps this independent. */
static const uint32_t k_dlc[16] = {
    FDCAN_DLC_BYTES_0,  FDCAN_DLC_BYTES_1,  FDCAN_DLC_BYTES_2,  FDCAN_DLC_BYTES_3,
    FDCAN_DLC_BYTES_4,  FDCAN_DLC_BYTES_5,  FDCAN_DLC_BYTES_6,  FDCAN_DLC_BYTES_7,
    FDCAN_DLC_BYTES_8,  FDCAN_DLC_BYTES_12, FDCAN_DLC_BYTES_16, FDCAN_DLC_BYTES_20,
    FDCAN_DLC_BYTES_24, FDCAN_DLC_BYTES_32, FDCAN_DLC_BYTES_48, FDCAN_DLC_BYTES_64,
};

uint8_t port_dlc_to_len(uint32_t hal_dlc)
{
    uint8_t i;
    for (i = 0; i < 16u; i++)
        if (k_dlc[i] == hal_dlc) return cycan_fd_dlc_to_len(i);
    return 0;
}

/* ---- CAN ------------------------------------------------------------------------- */

static bool port_can_send(void *ctx, const cycan_frame_t *f)
{
    FDCAN_TxHeaderTypeDef h;
    (void)ctx;
    if (HAL_FDCAN_GetTxFifoFreeLevel(&hfdcan1) == 0u) return false; /* library queues it */
    h.Identifier = f->id;
    h.IdType = FDCAN_EXTENDED_ID;
    h.TxFrameType = FDCAN_DATA_FRAME;
    h.DataLength = k_dlc[cycan_fd_len_to_dlc(f->len)];
    h.ErrorStateIndicator = FDCAN_ESI_ACTIVE;
    h.BitRateSwitch = (f->flags & CYCAN_FRAME_BRS) ? FDCAN_BRS_ON : FDCAN_BRS_OFF;
    h.FDFormat = (f->flags & CYCAN_FRAME_FD) ? FDCAN_FD_CAN : FDCAN_CLASSIC_CAN;
    h.TxEventFifoControl = FDCAN_NO_TX_EVENTS;
    h.MessageMarker = 0;
    return HAL_FDCAN_AddMessageToTxFifoQ(&hfdcan1, &h, (uint8_t *)f->data) == HAL_OK;
}

/* RX FIFO 0 interrupt: drain the FIFO into the library's ring. Nothing else happens here. */
void HAL_FDCAN_RxFifo0Callback(FDCAN_HandleTypeDef *hfdcan, uint32_t its)
{
    FDCAN_RxHeaderTypeDef h;
    uint8_t buf[64];
    (void)its;
    while (HAL_FDCAN_GetRxFifoFillLevel(hfdcan, FDCAN_RX_FIFO0) > 0u) {
        if (HAL_FDCAN_GetRxMessage(hfdcan, FDCAN_RX_FIFO0, &h, buf) != HAL_OK) break;
        if (h.IdType == FDCAN_EXTENDED_ID && h.RxFrameType == FDCAN_DATA_FRAME && s_node != NULL)
            (void)cycan_on_frame(s_node, h.Identifier, buf, port_dlc_to_len(h.DataLength));
    }
}

void port_bind_node(cycan_node_t *node)
{
    s_node = node;
}

void port_can_start(uint8_t data_bitrate)
{
    /* 160 MHz kernel clock. Nominal 1 Mbit/s: 160 tq, sample point 80 %. */
    static const struct {
        uint8_t presc, seg1, seg2;
    } k_data[4] = {
        {1, 127, 32}, /* classic: data phase = nominal, unused */
        {2, 29, 10},  /* 2 Mbit/s: 80 MHz / 40 tq, 75 % */
        {2, 11, 4},   /* 5 Mbit/s: 80 MHz / 16 tq, 75 % */
        {1, 14, 5},   /* 8 Mbit/s: 160 MHz / 20 tq, 75 % */
    };
    FDCAN_FilterTypeDef flt;
    uint8_t r = data_bitrate < 4u ? data_bitrate : 1u;

    HAL_FDCAN_DeInit(&hfdcan1);
    hfdcan1.Init.ClockDivider = FDCAN_CLOCK_DIV1;
    hfdcan1.Init.FrameFormat = r == 0u ? FDCAN_FRAME_CLASSIC : FDCAN_FRAME_FD_BRS;
    hfdcan1.Init.Mode = FDCAN_MODE_NORMAL;
    hfdcan1.Init.AutoRetransmission = ENABLE;
    hfdcan1.Init.TransmitPause = DISABLE;
    hfdcan1.Init.ProtocolException = DISABLE;
    hfdcan1.Init.NominalPrescaler = 1;
    hfdcan1.Init.NominalSyncJumpWidth = 32;
    hfdcan1.Init.NominalTimeSeg1 = 127;
    hfdcan1.Init.NominalTimeSeg2 = 32;
    hfdcan1.Init.DataPrescaler = k_data[r].presc;
    hfdcan1.Init.DataSyncJumpWidth = k_data[r].seg2;
    hfdcan1.Init.DataTimeSeg1 = k_data[r].seg1;
    hfdcan1.Init.DataTimeSeg2 = k_data[r].seg2;
    hfdcan1.Init.StdFiltersNbr = 0;
    hfdcan1.Init.ExtFiltersNbr = 1;
    hfdcan1.Init.TxFifoQueueMode = FDCAN_TX_FIFO_OPERATION; /* keeps the library's order */
    HAL_FDCAN_Init(&hfdcan1);

    /* Hardware filter: only MFR = 8 extended frames reach the CPU. */
    flt.IdType = FDCAN_EXTENDED_ID;
    flt.FilterIndex = 0;
    flt.FilterType = FDCAN_FILTER_MASK;
    flt.FilterConfig = FDCAN_FILTER_TO_RXFIFO0;
    flt.FilterID1 = (uint32_t)CYCAN_MFR << 16;
    flt.FilterID2 = 0x00FF0000u;
    HAL_FDCAN_ConfigFilter(&hfdcan1, &flt);
    HAL_FDCAN_ConfigGlobalFilter(&hfdcan1, FDCAN_REJECT, FDCAN_REJECT, FDCAN_REJECT_REMOTE, FDCAN_REJECT_REMOTE);

    if (r >= 2u) {
        /* 5 and 8 Mbit/s need transmitter delay compensation. */
        HAL_FDCAN_ConfigTxDelayCompensation(&hfdcan1, (uint32_t)k_data[r].presc * k_data[r].seg1, 0);
        HAL_FDCAN_EnableTxDelayCompensation(&hfdcan1);
    }
    HAL_FDCAN_ActivateNotification(&hfdcan1, FDCAN_IT_RX_FIFO0_NEW_MESSAGE, 0);
    HAL_FDCAN_Start(&hfdcan1);
}

uint32_t port_now_us(void)
{
    return TIM2->CNT; /* TIM2: 32-bit, prescaled to 1 MHz, free running */
}

/* ---- UID, randomness, LED -------------------------------------------------------- */

static void port_uid96(void *ctx, uint8_t out[12])
{
    (void)ctx;
    memcpy(out, (const void *)UID_BASE, 12); /* 0x1FFF7590 on G4: INFO page byte order */
}

/* The G431 has no RNG peripheral; the cycle counter's low bits at bus-event times jitter
 * enough to separate boards that collided once. */
static uint32_t port_random(void *ctx)
{
    (void)ctx;
    return DWT->CYCCNT ^ (TIM2->CNT << 16) ^ *(const uint32_t *)UID_BASE;
}

static void port_led(void *ctx, bool on)
{
    (void)ctx;
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, on ? GPIO_PIN_SET : GPIO_PIN_RESET); /* board LED */
}

/* ---- Storage: one flash page per region ------------------------------------------- */

static uint32_t region_addr(uint8_t region)
{
    return PORT_PAGE_ADDR(region == CYCAN_REGION_IDENTITY ? PORT_IDENTITY_PAGE : PORT_PARAMS_PAGE);
}

static bool port_read(void *ctx, uint8_t region, uint32_t off, void *buf, uint32_t len)
{
    (void)ctx;
    if (off + len > PORT_FLASH_PAGE_SIZE) return false;
    memcpy(buf, (const void *)(region_addr(region) + off), len);
    return true;
}

/* Blocks for ~22 ms (single bank: the CPU stalls on flash fetches meanwhile). The library
 * only erases on SAVE_PARAMS / ASSIGN_ID with persist, never while driving is expected. */
static bool port_erase(void *ctx, uint8_t region)
{
    FLASH_EraseInitTypeDef e;
    uint32_t err = 0;
    HAL_StatusTypeDef st;
    (void)ctx;
    e.TypeErase = FLASH_TYPEERASE_PAGES;
    e.Banks = FLASH_BANK_1;
    e.Page = region == CYCAN_REGION_IDENTITY ? PORT_IDENTITY_PAGE : PORT_PARAMS_PAGE;
    e.NbPages = 1;
    HAL_FLASH_Unlock();
    st = HAL_FLASHEx_Erase(&e, &err);
    HAL_FLASH_Lock();
    return st == HAL_OK;
}

static bool port_write(void *ctx, uint8_t region, uint32_t off, const void *buf, uint32_t len)
{
    const uint8_t *p = (const uint8_t *)buf;
    uint32_t addr = region_addr(region) + off, i;
    bool ok = true;
    (void)ctx;
    if (off + len > PORT_FLASH_PAGE_SIZE) return false;
    HAL_FLASH_Unlock();
    for (i = 0; i < len && ok; i += 8u) { /* the library guarantees 8-byte blocks */
        uint64_t dw;
        memcpy(&dw, p + i, 8);
        ok = HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD, addr + i, dw) == HAL_OK;
    }
    HAL_FLASH_Lock();
    return ok;
}

/* ---- Resets ---------------------------------------------------------------------- */

static void port_reboot(void *ctx)
{
    (void)ctx;
    g_port_boot_request = 0;
    NVIC_SystemReset();
}

static void port_enter_bootloader(void *ctx)
{
    (void)ctx;
    g_port_boot_request = PORT_BOOT_MAGIC;
    NVIC_SystemReset();
}

const cycan_hal_t g_port_hal = {
    NULL,          port_can_send, port_uid96,   port_read,   port_erase, port_write,
    port_reboot,   port_enter_bootloader,       port_led,    port_random,
};
