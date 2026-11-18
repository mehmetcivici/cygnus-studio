#include "cycan_boot.h"

#include <string.h>

#include "cycan.h" /* identity helpers and timing constants shared with the node */

#if defined(__GNUC__)
#define CYCAN_BARRIER() __asm__ __volatile__("" ::: "memory")
#else
#define CYCAN_BARRIER() ((void)0)
#endif

#define RX_MASK ((uint8_t)(CYCAN_BOOT_RX_QUEUE_LEN - 1u))
#define MS(x) ((uint32_t)((uint32_t)(x) * 1000u))

typedef char cycan_boot_chunk_is_multiple_of_8[(CYCAN_BOOT_WRITE_CHUNK % 8u) == 0u ? 1 : -1];
typedef char cycan_boot_rxq_is_power_of_2[(CYCAN_BOOT_RX_QUEUE_LEN & (CYCAN_BOOT_RX_QUEUE_LEN - 1u)) == 0u ? 1 : -1];

static bool due(uint32_t now, uint32_t t)
{
    return (int32_t)(now - t) >= 0;
}

static bool assigned(const cycan_boot_t *b)
{
    return b->cfg.num >= CYCAN_NUM_MIN && b->cfg.num <= CYCAN_NUM_MAX;
}

static uint8_t window(const cycan_boot_t *b)
{
    return b->cfg.window != 0u ? b->cfg.window : CYCAN_FW_WINDOW_DEFAULT;
}

static void send(cycan_boot_t *b, const cycan_frame_t *f)
{
    /* Replies are rare and the host retries on timeout, so no TX queue here. */
    (void)b->hal->can_send(b->hal->ctx, f);
}

/* Every ACK, whatever its status, restarts the window count (PROTOCOL 9). */
static void ack(cycan_boot_t *b, uint8_t status)
{
    cycan_frame_t f;
    cycan_fw_ack_t m;
    b->since_ack = 0;
    m.status = status;
    m.window = window(b);
    m.next_offset = b->next_offset;
    cycan_enc_fw_ack(&f, b->cfg.devtype, b->cfg.num, &m);
    send(b, &f);
}

static void send_enum_rsp(cycan_boot_t *b, bool ack_assign)
{
    cycan_frame_t f;
    cycan_enum_rsp_t m;
    m.uid48 = b->uid.uid48;
    m.num = b->cfg.num;
    m.conflict = false;
    m.bootloader = true;
    m.model = b->cfg.model;
    cycan_enc_enum_rsp(&f, b->cfg.devtype, &m);
    b->enum_pending = false;
    if (!b->hal->can_send(b->hal->ctx, &f) && !b->enum_retried && !ack_assign) {
        uint32_t r = b->hal->random != NULL ? b->hal->random(b->hal->ctx) : (uint32_t)b->uid.uid48 ^ b->now;
        b->enum_retried = true;
        b->enum_pending = true;
        b->enum_due = b->now + MS(r % (CYCAN_ENUM_RETRY_MAX_MS + 1u));
    }
}

static void send_heartbeat(cycan_boot_t *b)
{
    cycan_frame_t f;
    cycan_heartbeat_t m;
    memset(&m, 0, sizeof m);
    m.state = CYCAN_STATE_BOOTLOADER;
    m.identify = b->identify_on;
    m.uid16 = b->uid.uid16;
    m.fw_major = b->app_fw[0];
    m.fw_minor = b->app_fw[1];
    m.fw_patch = b->app_fw[2];
    cycan_enc_heartbeat(&f, b->cfg.devtype, b->cfg.num, &m);
    send(b, &f);
}

/* ---- Image ----------------------------------------------------------------------- */

static void abort_update(cycan_boot_t *b, uint8_t status)
{
    ack(b, status);
    b->state = CYCAN_BOOT_IDLE;
}

static bool wbuf_flush(cycan_boot_t *b)
{
    uint32_t len = (b->wbuf_len + 7u) & ~7u;
    bool ok;
    if (b->wbuf_len == 0u) return true;
    memset(b->wbuf + b->wbuf_len, 0xFF, len - b->wbuf_len);
    ok = b->hal->flash_write(b->hal->ctx, b->wbuf_base, b->wbuf, len);
    b->wbuf_base += b->wbuf_len;
    b->wbuf_len = 0;
    return ok;
}

static bool check_header(cycan_boot_t *b)
{
    cycan_cyfw_header_t h;
    return cycan_cyfw_check_header(b->header, b->cfg.model, b->cfg.hw_rev, &h) == CYCAN_CYFW_OK &&
           h.payload_size == b->size - CYCAN_CYFW_HEADER_SIZE;
}

static bool flash_crc(const cycan_boot_t *b, uint32_t from, uint32_t to, uint32_t *crc)
{
    uint8_t buf[64];
    uint32_t c = 0;
    while (from < to) {
        uint32_t n = to - from < sizeof buf ? to - from : (uint32_t)sizeof buf;
        if (!b->hal->flash_read(b->hal->ctx, from, buf, n)) return false;
        c = cycan_crc32_update(c, buf, n);
        from += n;
    }
    *crc = c;
    return true;
}

bool cycan_boot_image_valid(const cycan_boot_t *b)
{
    cycan_cyfw_header_t h;
    uint8_t hdr[CYCAN_CYFW_HEADER_SIZE];
    uint32_t crc;
    if (!b->hal->flash_read(b->hal->ctx, 0, hdr, sizeof hdr)) return false;
    if (cycan_cyfw_check_header(hdr, b->cfg.model, b->cfg.hw_rev, &h) != CYCAN_CYFW_OK) return false;
    if (h.payload_size > b->hal->image_capacity - CYCAN_CYFW_HEADER_SIZE) return false;
    return flash_crc(b, CYCAN_CYFW_HEADER_SIZE, CYCAN_CYFW_HEADER_SIZE + h.payload_size, &crc) && crc == h.payload_crc32;
}

static void on_begin(cycan_boot_t *b, const uint8_t *d, uint8_t len)
{
    cycan_fw_begin_t m;
    if (!cycan_dec_fw_begin(d, len, &m)) return;
    b->next_offset = 0;
    if (m.size < CYCAN_CYFW_HEADER_SIZE || m.size > b->hal->image_capacity || m.size > 0xFFFFFFul + 1u) {
        abort_update(b, CYCAN_FWST_BAD_IMAGE);
        return;
    }
    b->size = m.size;
    b->crc_expected = m.crc32;
    b->crc_file = 0;
    b->crc_payload = 0;
    b->since_ack = 0;
    b->bad_count = 0;
    b->header_ok = false;
    b->wbuf_base = 0;
    b->wbuf_len = 0;
    b->state = CYCAN_BOOT_ERASE;
    ack(b, CYCAN_FWST_BUSY);
}

static void on_data(cycan_boot_t *b, const uint8_t *d, uint8_t len)
{
    cycan_fw_data_t m;
    uint32_t n, i;
    if (!cycan_dec_fw_data(d, len, &m)) return;
    if (b->state == CYCAN_BOOT_ERASE) {
        ack(b, CYCAN_FWST_BUSY);
        return;
    }
    if (b->state != CYCAN_BOOT_RECEIVE) {
        ack(b, CYCAN_FWST_WRONG_STATE);
        return;
    }
    if (m.offset != b->next_offset) {
        /* One BAD_OFFSET per window of stray frames: the host resumes from next_offset, and
         * the frames it already had in flight should not each trigger another reply. */
        if (b->bad_count == 0u) ack(b, CYCAN_FWST_BAD_OFFSET);
        if (++b->bad_count >= window(b)) b->bad_count = 0;
        return;
    }
    b->bad_count = 0;
    /* Bytes past `size` are padding (short final chunk, FD length rounding). */
    n = b->size - b->next_offset;
    if (n > m.len) n = m.len;
    if (n == 0u) return;
    for (i = 0; i < n; i++) {
        uint32_t off = b->next_offset + i;
        if (off < CYCAN_CYFW_HEADER_SIZE) b->header[off] = m.bytes[i];
        b->wbuf[b->wbuf_len++] = m.bytes[i];
        if (b->wbuf_len == CYCAN_BOOT_WRITE_CHUNK && !wbuf_flush(b)) {
            abort_update(b, CYCAN_FWST_FLASH_ERROR);
            return;
        }
    }
    b->crc_file = cycan_crc32_update(b->crc_file, m.bytes, n);
    if (b->next_offset + n > CYCAN_CYFW_HEADER_SIZE) {
        uint32_t skip = b->next_offset < CYCAN_CYFW_HEADER_SIZE ? CYCAN_CYFW_HEADER_SIZE - b->next_offset : 0u;
        b->crc_payload = cycan_crc32_update(b->crc_payload, m.bytes + skip, n - skip);
    }
    b->next_offset += n;
    if (!b->header_ok && b->next_offset >= CYCAN_CYFW_HEADER_SIZE) {
        if (!check_header(b)) {
            abort_update(b, CYCAN_FWST_BAD_IMAGE);
            return;
        }
        b->header_ok = true;
    }
    if (++b->since_ack >= window(b)) ack(b, CYCAN_FWST_OK);
}

static void on_end(cycan_boot_t *b)
{
    uint32_t crc;
    cycan_cyfw_header_t h;
    if (b->state == CYCAN_BOOT_DONE) {
        ack(b, CYCAN_FWST_OK); /* repeated END after a lost ACK */
        return;
    }
    if (b->state != CYCAN_BOOT_RECEIVE) {
        ack(b, b->state == CYCAN_BOOT_ERASE ? CYCAN_FWST_BUSY : CYCAN_FWST_WRONG_STATE);
        return;
    }
    if (b->next_offset != b->size) {
        ack(b, CYCAN_FWST_BAD_OFFSET);
        return;
    }
    if (!wbuf_flush(b)) {
        abort_update(b, CYCAN_FWST_FLASH_ERROR);
        return;
    }
    if (b->crc_file != b->crc_expected) {
        abort_update(b, CYCAN_FWST_BAD_CRC);
        return;
    }
    (void)cycan_cyfw_check_header(b->header, b->cfg.model, b->cfg.hw_rev, &h);
    if (b->crc_payload != h.payload_crc32) {
        abort_update(b, CYCAN_FWST_BAD_IMAGE);
        return;
    }
    if (!flash_crc(b, 0, b->size, &crc) || crc != b->crc_expected) {
        abort_update(b, CYCAN_FWST_FLASH_ERROR);
        return;
    }
    b->app_fw[0] = h.fw_major;
    b->app_fw[1] = h.fw_minor;
    b->app_fw[2] = h.fw_patch;
    b->state = CYCAN_BOOT_DONE;
    b->start_pending = true;
    b->start_at = b->now + CYCAN_BOOT_START_DELAY_US;
    ack(b, CYCAN_FWST_OK);
}

/* ---- System requests ------------------------------------------------------------- */

static void identify(cycan_boot_t *b, uint8_t seconds)
{
    if (seconds == 0u) {
        if (b->identify_on && b->hal->led_set != NULL) b->hal->led_set(b->hal->ctx, false);
        b->identify_on = false;
        return;
    }
    b->identify_on = true;
    b->identify_end = b->now + MS(1000u * seconds);
    b->identify_next = b->now;
    b->identify_led = false;
}

static void on_sys(cycan_boot_t *b, uint8_t index, const uint8_t *d, uint8_t len)
{
    cycan_frame_t f;
    switch (index) {
    case CYCAN_SYS_ENUM_REQ: {
        cycan_enum_req_t m;
        if (!cycan_dec_enum_req(d, len, &m) || (m.filter == CYCAN_ENUM_FILTER_UNASSIGNED && assigned(b))) return;
        if (!b->enum_pending) {
            b->enum_pending = true;
            b->enum_retried = false;
            b->enum_due = b->now + MS(b->uid.enum_delay_ms);
        }
        break;
    }
    case CYCAN_SYS_ASSIGN_ID: {
        cycan_assign_id_t m;
        if (!cycan_dec_assign_id(d, len, &m) || m.uid48 != b->uid.uid48 || m.new_num < CYCAN_NUM_MIN ||
            m.new_num > CYCAN_NUM_UNASSIGNED)
            return;
        b->cfg.num = m.new_num;
        b->enum_pending = false;
        send_enum_rsp(b, true);
        if (m.persist && b->hal->identity_save != NULL) (void)b->hal->identity_save(b->hal->ctx, m.new_num);
        b->hb_next = b->now;
        break;
    }
    case CYCAN_SYS_IDENTIFY: {
        cycan_identify_t m;
        if (cycan_dec_identify(d, len, &m) && (m.uid_form ? m.uid48 == b->uid.uid48 : assigned(b))) identify(b, m.seconds);
        break;
    }
    case CYCAN_SYS_INFO_REQ: {
        cycan_info_req_t m;
        if (!assigned(b) || !cycan_dec_info_req(d, len, &m)) return;
        if (m.page == CYCAN_INFO_DEVICE) {
            cycan_info_device_t i;
            i.model = b->cfg.model;
            i.hw_rev = b->cfg.hw_rev;
            i.proto_major = CYCAN_PROTO_MAJOR;
            i.proto_minor = CYCAN_PROTO_MINOR;
            i.catalog_rev = b->cfg.catalog_rev;
            i.bootloader_ver = b->cfg.bootloader_ver;
            cycan_enc_info_device(&f, b->cfg.devtype, b->cfg.num, &i);
        } else if (m.page == CYCAN_INFO_UID_LO || m.page == CYCAN_INFO_UID_HI) {
            cycan_info_rsp_t r;
            memset(&r, 0, sizeof r);
            r.page = m.page;
            if (m.page == CYCAN_INFO_UID_LO) memcpy(r.bytes, b->uid96, 7);
            else memcpy(r.bytes, b->uid96 + 7, 5);
            cycan_enc_info_rsp(&f, b->cfg.devtype, b->cfg.num, &r);
        } else {
            return;
        }
        send(b, &f);
        break;
    }
    case CYCAN_SYS_COMMAND: {
        cycan_command_t m;
        cycan_command_rsp_t r;
        /* Only REBOOT is answered; everything else stays unanswered (PROTOCOL 9). */
        if (!assigned(b) || !cycan_dec_command(d, len, &m) || m.cmd != CYCAN_CMD_REBOOT) return;
        r.cmd = m.cmd;
        r.result = 0;
        /* Leaving the bootloader only makes sense with a valid image to start. */
        r.status = cycan_boot_image_valid(b) ? CYCAN_CMDST_OK : CYCAN_CMDST_FAILED;
        if (r.status == CYCAN_CMDST_OK) {
            b->start_pending = true;
            b->start_at = b->now + CYCAN_BOOT_START_DELAY_US;
        }
        cycan_enc_command_rsp(&f, b->cfg.devtype, b->cfg.num, &r);
        send(b, &f);
        break;
    }
    default:
        break;
    }
}

static void handle(cycan_boot_t *b, const cycan_frame_t *f)
{
    uint8_t index = CYCAN_ID_INDEX(f->id);
    if (!cycan_accepts(f->id, b->cfg.devtype, b->cfg.num)) return;
    switch (CYCAN_ID_CLASS(f->id)) {
    case CYCAN_CLS_SYS_REQ:
        on_sys(b, index, f->data, f->len);
        break;
    case CYCAN_CLS_FW_REQ:
        /* FW frames must be addressed to this board: a bus-wide broadcast would reflash
         * every board in its bootloader at once. NUM 63 is allowed so an unassigned board
         * can still be recovered by its address (devtype, 63). */
        if (CYCAN_ID_NUM(f->id) != b->cfg.num) return;
        if (index == CYCAN_FW_BEGIN) on_begin(b, f->data, f->len);
        else if (index == CYCAN_FW_DATA) on_data(b, f->data, f->len);
        else if (index == CYCAN_FW_END) on_end(b);
        break;
    default:
        break;
    }
}

/* ---- Public API ------------------------------------------------------------------ */

void cycan_boot_init(cycan_boot_t *b, const cycan_boot_cfg_t *cfg, const cycan_boot_hal_t *hal, uint32_t now_us)
{
    uint8_t hdr[CYCAN_CYFW_HEADER_SIZE];
    cycan_cyfw_header_t h;
    memset(b, 0, sizeof *b);
    b->cfg = *cfg;
    b->hal = hal;
    b->now = now_us;
    if (hal->uid96 != NULL) hal->uid96(hal->ctx, b->uid96);
    cycan_uid_derive(b->uid96, &b->uid);
    b->hb_next = now_us + MS(b->uid.uid16 % (CYCAN_HEARTBEAT_PHASE_MAX_MS + 1u));
    /* Report the installed application's version, if its header is intact. */
    if (hal->flash_read(hal->ctx, 0, hdr, sizeof hdr) &&
        cycan_cyfw_check_header(hdr, cfg->model, cfg->hw_rev, &h) == CYCAN_CYFW_OK) {
        b->app_fw[0] = h.fw_major;
        b->app_fw[1] = h.fw_minor;
        b->app_fw[2] = h.fw_patch;
    }
}

bool cycan_boot_on_frame(cycan_boot_t *b, uint32_t id, const uint8_t *data, uint8_t len)
{
    uint8_t head = b->rx_head, next = (uint8_t)((head + 1u) & RX_MASK);
    cycan_frame_t *e;
    if (!cycan_accepts(id, b->cfg.devtype, b->cfg.num)) return false;
    if (next == b->rx_tail) {
        b->rx_overruns++;
        return false;
    }
    e = &b->rxq[head];
    e->id = id;
    e->len = len > CYCAN_FRAME_MAX_DATA ? (uint8_t)CYCAN_FRAME_MAX_DATA : len;
    e->flags = len > 8u ? CYCAN_FRAME_FD : 0u;
    memcpy(e->data, data, e->len);
    CYCAN_BARRIER();
    b->rx_head = next;
    return true;
}

void cycan_boot_poll(cycan_boot_t *b, uint32_t now_us)
{
    b->now = now_us;
    while (b->rx_tail != b->rx_head) {
        const cycan_frame_t *f = &b->rxq[b->rx_tail];
        CYCAN_BARRIER();
        handle(b, f);
        /* Released only after handling: DATA is processed in place (no 64-byte copy). */
        b->rx_tail = (uint8_t)((b->rx_tail + 1u) & RX_MASK);
    }
    if (b->state == CYCAN_BOOT_ERASE) {
        if (b->hal->flash_erase(b->hal->ctx, b->size)) {
            b->state = CYCAN_BOOT_RECEIVE;
            ack(b, CYCAN_FWST_OK);
        } else {
            abort_update(b, CYCAN_FWST_FLASH_ERROR);
        }
    }
    if (b->enum_pending && due(b->now, b->enum_due)) send_enum_rsp(b, false);
    if (assigned(b) && due(b->now, b->hb_next)) {
        send_heartbeat(b);
        b->hb_next += MS(CYCAN_HEARTBEAT_MS);
        if (due(b->now, b->hb_next)) b->hb_next = b->now + MS(CYCAN_HEARTBEAT_MS);
    }
    if (b->identify_on) {
        if (due(b->now, b->identify_end)) {
            identify(b, 0);
        } else if (due(b->now, b->identify_next)) {
            b->identify_led = !b->identify_led;
            b->identify_next = b->now + MS(100);
            if (b->hal->led_set != NULL) b->hal->led_set(b->hal->ctx, b->identify_led);
        }
    }
    if (b->start_pending && due(b->now, b->start_at)) {
        b->start_pending = false;
        b->hal->start_app(b->hal->ctx);
    }
}

cycan_boot_state_t cycan_boot_state(const cycan_boot_t *b)
{
    return b->state;
}
