#include "fake.h"

#include <string.h>

static bool f_send(void *ctx, const cycan_frame_t *fr)
{
    fake_t *f = (fake_t *)ctx;
    if (f->send_fail > 0) {
        f->send_fail--;
        return false;
    }
    if (f->nsent < FAKE_MAX_SENT) f->sent[f->nsent++] = *fr;
    return true;
}

static void f_uid(void *ctx, uint8_t out[12])
{
    memcpy(out, ((fake_t *)ctx)->uid96, 12);
}

static bool f_read(void *ctx, uint8_t slot, uint32_t off, void *buf, uint32_t len)
{
    fake_t *f = (fake_t *)ctx;
    if (f->dead || slot > 1u || off > FAKE_REGION_SIZE || len > FAKE_REGION_SIZE - off) return false;
    memcpy(buf, f->region[slot] + off, len);
    return true;
}

static bool f_erase(void *ctx, uint8_t slot)
{
    fake_t *f = (fake_t *)ctx;
    if (f->dead || slot > 1u) return false;
    if (f->cut_budget == 0) {
        memset(f->region[slot], 0xFF, FAKE_REGION_SIZE / 2u);
        f->dead = true;
        return false;
    }
    memset(f->region[slot], 0xFF, FAKE_REGION_SIZE);
    f->erases++;
    return true;
}

static bool f_write(void *ctx, uint8_t slot, uint32_t off, const void *buf, uint32_t len)
{
    fake_t *f = (fake_t *)ctx;
    uint32_t i, n = len;
    /* Enforce the HAL contract: 8-byte aligned blocks into erased storage. */
    if (f->dead || slot > 1u || off > FAKE_REGION_SIZE || len > FAKE_REGION_SIZE - off || off % 8u != 0u || len % 8u != 0u)
        return false;
    for (i = 0; i < len; i++)
        if (f->region[slot][off + i] != 0xFFu) return false;
    if (f->cut_budget >= 0 && (long)len > f->cut_budget) n = (uint32_t)f->cut_budget;
    memcpy(f->region[slot] + off, buf, n);
    f->programmed += (long)n;
    if (f->cut_budget >= 0) f->cut_budget -= (long)n;
    if (n < len) {
        f->dead = true;
        return false;
    }
    f->writes++;
    f->nsent_at_store = f->nsent;
    return true;
}

static void f_can_config(void *ctx, uint8_t rate)
{
    fake_t *f = (fake_t *)ctx;
    f->can_configs++;
    f->can_bitrate = rate;
}

static void f_reboot(void *ctx)
{
    ((fake_t *)ctx)->reboots++;
}

static void f_boot(void *ctx)
{
    ((fake_t *)ctx)->bootloaders++;
}

static void f_led(void *ctx, bool on)
{
    fake_t *f = (fake_t *)ctx;
    f->led_calls++;
    f->led = on;
}

static uint32_t f_rand(void *ctx)
{
    fake_t *f = (fake_t *)ctx;
    f->rnd = f->rnd * 1103515245u + 12345u;
    return f->rnd >> 8;
}

static bool f_flash_erase(void *ctx, uint32_t size)
{
    fake_t *f = (fake_t *)ctx;
    if (f->flash_fail || size > FAKE_FLASH_SIZE) return false;
    memset(f->flash, 0xFF, FAKE_FLASH_SIZE);
    f->erases++;
    return true;
}

static bool f_flash_write(void *ctx, uint32_t off, const uint8_t *data, uint32_t len)
{
    fake_t *f = (fake_t *)ctx;
    uint32_t i;
    if (f->flash_fail || off + len > FAKE_FLASH_SIZE || off % 8u != 0u || len % 8u != 0u) return false;
    for (i = 0; i < len; i++)
        if (f->flash[off + i] != 0xFFu) return false;
    memcpy(f->flash + off, data, len);
    f->writes++;
    return true;
}

static bool f_flash_read(void *ctx, uint32_t off, uint8_t *data, uint32_t len)
{
    fake_t *f = (fake_t *)ctx;
    if (off + len > FAKE_FLASH_SIZE) return false;
    memcpy(data, f->flash + off, len);
    return true;
}

static void f_start(void *ctx)
{
    ((fake_t *)ctx)->app_starts++;
}

void fake_init(fake_t *f, uint8_t uid_seed)
{
    int i;
    memset(f, 0, sizeof *f);
    for (i = 0; i < 12; i++) f->uid96[i] = (uint8_t)(uid_seed + i * 17);
    memset(f->region, 0xFF, sizeof f->region);
    memset(f->flash, 0xFF, sizeof f->flash);
    f->rnd = uid_seed;
    f->cut_budget = -1;
    f->hal.ctx = f;
    f->hal.can_send = f_send;
    f->hal.uid96 = f_uid;
    f->hal.storage_read = f_read;
    f->hal.storage_erase = f_erase;
    f->hal.storage_write = f_write;
    f->hal.reboot = f_reboot;
    f->hal.enter_bootloader = f_boot;
    f->hal.led_set = f_led;
    f->hal.random = f_rand;
    f->boot_hal.ctx = f;
    f->boot_hal.can_send = f_send;
    f->boot_hal.uid96 = f_uid;
    f->boot_hal.image_capacity = FAKE_FLASH_SIZE;
    f->boot_hal.flash_erase = f_flash_erase;
    f->boot_hal.flash_write = f_flash_write;
    f->boot_hal.flash_read = f_flash_read;
    f->boot_hal.start_app = f_start;
    f->boot_hal.led_set = f_led;
    f->boot_hal.random = f_rand;
    f->boot_hal.can_config = f_can_config;
    f->boot_hal.storage_read = f_read;
    f->boot_hal.storage_erase = f_erase;
    f->boot_hal.storage_write = f_write;
}

void fake_clear(fake_t *f)
{
    f->nsent = 0;
}

static bool match(const cycan_frame_t *fr, uint8_t cls, uint8_t index)
{
    return CYCAN_ID_CLASS(fr->id) == cls && (index == 0xFFu || CYCAN_ID_INDEX(fr->id) == index);
}

int fake_count(const fake_t *f, uint8_t cls, uint8_t index)
{
    int i, c = 0;
    for (i = 0; i < f->nsent; i++)
        if (match(&f->sent[i], cls, index)) c++;
    return c;
}

const cycan_frame_t *fake_find(const fake_t *f, uint8_t cls, uint8_t index, int n)
{
    int i;
    for (i = 0; i < f->nsent; i++)
        if (match(&f->sent[i], cls, index) && n-- == 0) return &f->sent[i];
    return NULL;
}

const cycan_frame_t *fake_last(const fake_t *f, uint8_t cls, uint8_t index)
{
    int i;
    for (i = f->nsent - 1; i >= 0; i--)
        if (match(&f->sent[i], cls, index)) return &f->sent[i];
    return NULL;
}

void to_node(cycan_node_t *n, const cycan_frame_t *fr)
{
    (void)cycan_on_frame(n, fr->id, fr->data, fr->len);
}

void to_boot(cycan_boot_t *b, const cycan_frame_t *fr)
{
    (void)cycan_boot_on_frame(b, fr->id, fr->data, fr->len);
}

void run_ms(cycan_node_t *n, uint32_t *now, uint32_t ms)
{
    uint32_t i;
    for (i = 0; i < ms; i++) {
        *now += 1000u;
        cycan_poll(n, *now);
    }
}

void run_boot_ms(cycan_boot_t *b, uint32_t *now, uint32_t ms)
{
    uint32_t i;
    for (i = 0; i < ms; i++) {
        *now += 1000u;
        cycan_boot_poll(b, *now);
    }
}
