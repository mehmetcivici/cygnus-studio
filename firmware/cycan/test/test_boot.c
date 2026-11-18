/* Bootloader: recovery window, FW update state machine, image checks, bootloader presence
 * on the bus. */
#include <string.h>

#include "fake.h"
#include "test.h"

#define DT CYCAN_CYNCODER_DEVTYPE
#define NUM 4u
#define PAYLOAD 1003u

static fake_t fk;
static cycan_boot_t bl;
static uint32_t now;
static uint8_t image[CYCAN_CYFW_HEADER_SIZE + PAYLOAD + CYCAN_CYFW_SIGNATURE_SIZE];
static uint32_t image_size;

static cycan_store_io_t io(void)
{
    cycan_store_io_t s;
    s.ctx = &fk;
    s.read = fk.boot_hal.storage_read;
    s.erase = fk.boot_hal.storage_erase;
    s.write = fk.boot_hal.storage_write;
    return s;
}

static void build_image_ex(uint8_t model, uint8_t hw_min, uint8_t hw_max, uint8_t minor, bool signed_image)
{
    cycan_cyfw_header_t h;
    uint32_t i;
    for (i = 0; i < PAYLOAD; i++) image[CYCAN_CYFW_HEADER_SIZE + i] = (uint8_t)(i * 7u + 3u + minor);
    memset(&h, 0, sizeof h);
    h.model = model;
    h.hw_rev_min = hw_min;
    h.hw_rev_max = hw_max;
    h.fw_major = 1;
    h.fw_minor = minor;
    h.fw_patch = 2;
    h.payload_size = PAYLOAD;
    h.payload_crc32 = cycan_crc32(image + CYCAN_CYFW_HEADER_SIZE, PAYLOAD);
    h.catalog_rev = 1;
    h.flags = signed_image ? CYCAN_CYFW_FLAG_SIGNED : 0u;
    strcpy(h.name, "cyncoder-test");
    cycan_cyfw_encode_header(image, &h);
    image_size = CYCAN_CYFW_HEADER_SIZE + PAYLOAD;
    if (signed_image) {
        for (i = 0; i < CYCAN_CYFW_SIGNATURE_SIZE; i++) image[image_size + i] = (uint8_t)(0xA0u + i);
        image_size += CYCAN_CYFW_SIGNATURE_SIZE;
    }
}

static void build_image(uint8_t model, uint8_t hw_min, uint8_t hw_max)
{
    build_image_ex(model, hw_min, hw_max, 5, false);
}

static cycan_boot_cfg_t default_cfg(uint8_t hw_rev)
{
    cycan_boot_cfg_t cfg;
    cfg.model = CYCAN_MODEL_CYNCODER;
    cfg.devtype = DT;
    cfg.hw_rev = hw_rev;
    cfg.bootloader_ver = 3;
    cfg.catalog_rev = 1;
    cfg.window = 0;
    cfg.data_bitrate_default = 1;
    cfg.stay = true;
    return cfg;
}

/* Fresh board, NUM 4 in the store, in the bootloader because asked to stay. */
static void setup(uint8_t hw_rev)
{
    cycan_boot_cfg_t cfg = default_cfg(hw_rev);
    cycan_store_io_t s;
    now = 0;
    fake_init(&fk, 0x42);
    s = io();
    CHECK(cycan_store_set_num(&s, CYCAN_MODEL_CYNCODER, NUM));
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    CHECK_EQ(cycan_boot_num(&bl), NUM);
    build_image(CYCAN_MODEL_CYNCODER, 1, 2);
}

/* Power cycle (flash and store keep their contents). */
static void power_cycle(bool stay)
{
    cycan_boot_cfg_t cfg = bl.cfg;
    cfg.stay = stay;
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
}

static int acks(uint8_t status)
{
    int i, c = 0;
    cycan_fw_ack_t a;
    for (i = 0; i < fk.nsent; i++)
        if (CYCAN_ID_CLASS(fk.sent[i].id) == CYCAN_CLS_FW_RSP && cycan_dec_fw_ack(fk.sent[i].data, fk.sent[i].len, &a) && a.status == status)
            c++;
    return c;
}

static bool last_ack(cycan_fw_ack_t *a)
{
    const cycan_frame_t *f = fake_last(&fk, CYCAN_CLS_FW_RSP, CYCAN_FW_ACK);
    return f != NULL && cycan_dec_fw_ack(f->data, f->len, a);
}

static void begin(uint32_t size, uint32_t crc)
{
    cycan_frame_t f;
    cycan_fw_begin_t m;
    m.size = size;
    m.crc32 = crc;
    cycan_enc_fw_begin(&f, DT, NUM, &m);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 2);
}

static void data(uint32_t off, uint8_t chunk)
{
    cycan_frame_t f;
    cycan_fw_data_t m;
    uint32_t left = image_size - off;
    m.offset = off;
    m.len = (uint8_t)(left < chunk ? left : chunk);
    m.bytes = image + off;
    CHECK(cycan_enc_fw_data(&f, DT, NUM, &m));
    to_boot(&bl, &f);
    cycan_boot_poll(&bl, now);
}

static void end(void)
{
    cycan_frame_t f;
    cycan_enc_fw_end(&f, DT, NUM);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
}

/* Host behaviour: send chunks from `from` (optionally dropping chunk index `drop`); when the
 * header is complete the board erases and asks to resume at 64. */
static void send_all(uint8_t chunk, uint32_t from, int drop)
{
    uint32_t off = from;
    int k = 0;
    while (off < image_size) {
        if (k != drop) data(off, chunk);
        if (from < CYCAN_CYFW_HEADER_SIZE && off < CYCAN_CYFW_HEADER_SIZE && off + chunk >= CYCAN_CYFW_HEADER_SIZE &&
            cycan_boot_state(&bl) == CYCAN_BOOT_RECEIVE) {
            off = CYCAN_CYFW_HEADER_SIZE;
        } else {
            off += chunk;
        }
        k++;
    }
}

static void happy(uint8_t chunk)
{
    cycan_fw_ack_t a;
    int erases;
    setup(1);
    erases = fk.erases;
    CHECK(!cycan_boot_image_valid(&bl));
    begin(image_size, cycan_crc32(image, image_size));
    /* BEGIN alone erases nothing. */
    CHECK_EQ(acks(CYCAN_FWST_OK), 1);
    CHECK_EQ(acks(CYCAN_FWST_BUSY), 0);
    CHECK_EQ(fk.erases, erases);
    CHECK(last_ack(&a) && a.window == CYCAN_FW_WINDOW_DEFAULT && a.next_offset == 0);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_HEADER);
    fake_clear(&fk);
    send_all(chunk, 0, -1);
    /* Header complete: BUSY, erase, OK with next_offset 64. */
    CHECK_EQ(acks(CYCAN_FWST_BUSY), 1);
    {
        const cycan_frame_t *f = fake_find(&fk, CYCAN_CLS_FW_RSP, CYCAN_FW_ACK, 1);
        CHECK(f != NULL && cycan_dec_fw_ack(f->data, f->len, &a) && a.status == CYCAN_FWST_OK && a.next_offset == 64);
    }
    {
        uint32_t frames = (image_size - CYCAN_CYFW_HEADER_SIZE + chunk - 1u) / chunk;
        CHECK_EQ(acks(CYCAN_FWST_OK), 1u + frames / CYCAN_FW_WINDOW_DEFAULT);
        CHECK_EQ(acks(CYCAN_FWST_BAD_OFFSET), 0);
    }
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK && a.next_offset == image_size);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_DONE);
    CHECK(memcmp(fk.flash, image, image_size) == 0);
    CHECK(cycan_boot_image_valid(&bl));
    CHECK_EQ(fk.app_starts, 0);
    run_boot_ms(&bl, &now, 10);
    CHECK_EQ(fk.app_starts, 1);
}

void test_boot_happy_classic(void)
{
    happy(CYCAN_FW_CHUNK_CLASSIC);
}

void test_boot_happy_fd(void)
{
    happy(CYCAN_FW_CHUNK_FD);
}

void test_boot_signed_image(void)
{
    cycan_fw_ack_t a;
    setup(1);
    build_image_ex(CYCAN_MODEL_CYNCODER, 1, 2, 6, true);
    begin(image_size, cycan_crc32(image, image_size));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
    CHECK(cycan_boot_image_valid(&bl));
    /* Without the signature the sizes disagree. */
    setup(1);
    build_image_ex(CYCAN_MODEL_CYNCODER, 1, 2, 6, true);
    begin(image_size - CYCAN_CYFW_SIGNATURE_SIZE, 0);
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);
}

void test_boot_out_of_order(void)
{
    cycan_fw_ack_t a;
    const int drop = 20; /* chunk index counted from 64 */
    const uint32_t lost = CYCAN_CYFW_HEADER_SIZE + (uint32_t)drop * CYCAN_FW_CHUNK_CLASSIC;
    uint32_t off;
    int k;
    setup(2);
    begin(image_size, cycan_crc32(image, image_size));
    for (off = 0; cycan_boot_state(&bl) == CYCAN_BOOT_HEADER; off += CYCAN_FW_CHUNK_CLASSIC) data(off, CYCAN_FW_CHUNK_CLASSIC);
    fake_clear(&fk);
    /* Chunk `drop` is lost; the following in-flight frames are stray: a single BAD_OFFSET. */
    for (k = 0, off = CYCAN_CYFW_HEADER_SIZE; off < image_size; off += CYCAN_FW_CHUNK_CLASSIC, k++)
        if (k != drop) data(off, CYCAN_FW_CHUNK_CLASSIC);
    CHECK(acks(CYCAN_FWST_BAD_OFFSET) >= 1);
    {
        const cycan_frame_t *f = NULL;
        int i;
        for (i = 0; i < fk.nsent && f == NULL; i++)
            if (cycan_dec_fw_ack(fk.sent[i].data, fk.sent[i].len, &a) && a.status == CYCAN_FWST_BAD_OFFSET) f = &fk.sent[i];
        CHECK(f != NULL && a.next_offset == lost);
    }
    /* Stray frames are rate limited to one reply per window. */
    CHECK(acks(CYCAN_FWST_BAD_OFFSET) <= (int)((image_size / CYCAN_FW_CHUNK_CLASSIC) / CYCAN_FW_WINDOW_DEFAULT) + 1);
    /* END before everything arrived. */
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_OFFSET && a.next_offset == lost);
    /* Host resumes from next_offset. */
    send_all(CYCAN_FW_CHUNK_CLASSIC, a.next_offset, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
    CHECK(memcmp(fk.flash, image, image_size) == 0);

    /* After BAD_OFFSET the window restarts: resuming at next_offset, the first OK comes
     * after exactly `window` good frames. */
    setup(2);
    begin(image_size, cycan_crc32(image, image_size));
    for (off = 0; cycan_boot_state(&bl) == CYCAN_BOOT_HEADER; off += CYCAN_FW_CHUNK_CLASSIC) data(off, CYCAN_FW_CHUNK_CLASSIC);
    for (k = 0, off = CYCAN_CYFW_HEADER_SIZE; k < drop; k++, off += CYCAN_FW_CHUNK_CLASSIC) data(off, CYCAN_FW_CHUNK_CLASSIC);
    data(off + CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC); /* stray */
    fake_clear(&fk);
    for (k = 0; k < (int)CYCAN_FW_WINDOW_DEFAULT - 1; k++) data(lost + (uint32_t)k * CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC);
    CHECK_EQ(acks(CYCAN_FWST_OK), 0);
    data(lost + (CYCAN_FW_WINDOW_DEFAULT - 1u) * CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC);
    CHECK_EQ(acks(CYCAN_FWST_OK), 1);
    send_all(CYCAN_FW_CHUNK_CLASSIC, lost + CYCAN_FW_WINDOW_DEFAULT * CYCAN_FW_CHUNK_CLASSIC, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
}

void test_boot_bad_crc(void)
{
    cycan_fw_ack_t a;
    setup(1);
    begin(image_size, cycan_crc32(image, image_size) ^ 1u);
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_CRC);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    run_boot_ms(&bl, &now, 20);
    CHECK_EQ(fk.app_starts, 0);

    /* File CRC right but the payload does not match the header's payload CRC. */
    image[CYCAN_CYFW_HEADER_SIZE + 10] ^= 0xFFu;
    begin(image_size, cycan_crc32(image, image_size));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    CHECK(!cycan_boot_image_valid(&bl));
    /* No valid image: the heartbeat reports 0.0.0, also after a power cycle. */
    power_cycle(false);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    fake_clear(&fk);
    run_boot_ms(&bl, &now, 600);
    {
        cycan_heartbeat_t hb;
        const cycan_frame_t *f = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
        CHECK(f != NULL && cycan_dec_heartbeat(f->data, f->len, &hb) && hb.fw_major == 0 && hb.fw_minor == 0 && hb.fw_patch == 0);
    }
}

void test_boot_wrong_image(void)
{
    cycan_fw_ack_t a;
    uint8_t before[CYCAN_CYFW_HEADER_SIZE + PAYLOAD];
    int erases;
    /* A valid application is installed. */
    happy(CYCAN_FW_CHUNK_FD);
    power_cycle(true);
    memcpy(before, fk.flash, sizeof before);
    erases = fk.erases;

    /* Another model's image (same DEVTYPE family mistake): refused before any erase, the
     * installed application stays (finding 8). */
    build_image(CYCAN_MODEL_ESC20A, 1, 2);
    begin(image_size, cycan_crc32(image, image_size));
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    CHECK_EQ(fk.erases, erases);
    CHECK(memcmp(fk.flash, before, sizeof before) == 0);
    CHECK(cycan_boot_image_valid(&bl));
    data(122, CYCAN_FW_CHUNK_FD);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);

    /* Hardware revision outside the image's range: same. */
    build_image(CYCAN_MODEL_CYNCODER, 2, 3);
    begin(image_size, cycan_crc32(image, image_size));
    fake_clear(&fk);
    send_all(CYCAN_FW_CHUNK_CLASSIC, 0, -1);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);
    CHECK_EQ(fk.erases, erases);
    CHECK(cycan_boot_image_valid(&bl));

    /* Impossible sizes are refused at BEGIN. */
    build_image(CYCAN_MODEL_CYNCODER, 1, 2);
    fake_clear(&fk);
    begin(FAKE_FLASH_SIZE + 1u, 0);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    begin(10, 0);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    /* Header size field disagreeing with BEGIN size. */
    begin(image_size + 8u, 0);
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);
    CHECK_EQ(fk.erases, erases);

    /* DATA / END without BEGIN. */
    setup(1);
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_CLASSIC);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);

    /* Flash failure while erasing. */
    fk.flash_fail = true;
    begin(image_size, cycan_crc32(image, image_size));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    CHECK(acks(CYCAN_FWST_FLASH_ERROR) >= 1);
}

void test_boot_data_length(void)
{
    cycan_frame_t f;
    cycan_fw_ack_t a;
    setup(1);
    begin(image_size, cycan_crc32(image, image_size));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    /* PROTOCOL 9: payload + 3 must be a valid frame length; a 35-byte frame is ignored
     * rather than treating its padding as data. */
    memset(f.data, 0, sizeof f.data);
    cycan_wr_u24(f.data, image_size);
    f.id = cycan_id_encode(DT, CYCAN_CLS_FW_REQ, CYCAN_FW_DATA, NUM);
    f.len = 35;
    fake_clear(&fk);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    CHECK_EQ(fk.nsent, 0);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
}

void test_boot_races(void)
{
    cycan_fw_ack_t a;
    cycan_frame_t f;
    cycan_command_t c;
    /* finding 7: BEGIN within 5 ms after END must not start an erased image. */
    happy(CYCAN_FW_CHUNK_FD);
    power_cycle(true);
    begin(image_size, cycan_crc32(image, image_size));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    end();
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_DONE);
    fake_clear(&fk);
    begin(image_size, 0); /* 2 ms after END */
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BUSY);
    data(0, CYCAN_FW_CHUNK_FD);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BUSY);
    end(); /* repeated END after a lost ACK */
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BUSY);
    run_boot_ms(&bl, &now, 10);
    CHECK_EQ(fk.app_starts, 2);
    CHECK(cycan_boot_image_valid(&bl));

    /* REBOOT answered OK, then BEGIN before the start: the start is cancelled. */
    power_cycle(true);
    c.cmd = CYCAN_CMD_REBOOT;
    c.arg = 0;
    cycan_enc_command(&f, DT, NUM, &c);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    begin(image_size, cycan_crc32(image, image_size));
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD); /* header complete: erased */
    run_boot_ms(&bl, &now, 20);
    CHECK_EQ(fk.app_starts, 2);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_RECEIVE);
}

static void recovery_frame(uint8_t devtype, uint8_t num, uint32_t arg)
{
    cycan_frame_t f;
    cycan_command_t c;
    c.cmd = CYCAN_CMD_ENTER_BOOTLOADER;
    c.arg = arg;
    cycan_enc_command(&f, devtype, num, &c);
    to_boot(&bl, &f);
}

void test_boot_recovery_window(void)
{
    happy(CYCAN_FW_CHUNK_FD);
    /* Valid image, no request: listen silently for 150 ms, then start. */
    power_cycle(false);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_WINDOW);
    fake_clear(&fk);
    run_boot_ms(&bl, &now, CYCAN_RECOVERY_WINDOW_MS - 1u);
    CHECK_EQ(fk.app_starts, 1);
    CHECK_EQ(fk.nsent, 0);
    run_boot_ms(&bl, &now, 2);
    CHECK_EQ(fk.app_starts, 2);

    /* Addressed or wrong-arg frames do not hold it. */
    power_cycle(false);
    recovery_frame(DT, NUM, CYCAN_BOOT_RECOVERY_ARG);
    recovery_frame(0, 0, CYCAN_BOOT_INTENT | bl.uid.uid16);
    run_boot_ms(&bl, &now, CYCAN_RECOVERY_WINDOW_MS + 1u);
    CHECK_EQ(fk.app_starts, 3);

    /* The recovery broadcast keeps it in the bootloader (PROTOCOL 9.0). */
    power_cycle(false);
    fake_clear(&fk);
    run_boot_ms(&bl, &now, 100);
    recovery_frame(0, 0, CYCAN_BOOT_RECOVERY_ARG);
    run_boot_ms(&bl, &now, 600);
    CHECK_EQ(fk.app_starts, 3);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    {
        cycan_heartbeat_t hb;
        const cycan_frame_t *f = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
        CHECK(f != NULL && cycan_dec_heartbeat(f->data, f->len, &hb) && hb.state == CYCAN_STATE_BOOTLOADER && hb.fw_minor == 5);
    }
    /* No valid image: no window, straight into the bootloader. */
    setup(1);
    power_cycle(false);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
}

static bool one_rec(void *src, uint16_t i, uint8_t rec[8])
{
    (void)i;
    memcpy(rec, src, 8);
    return true;
}

static void store_bitrate(uint32_t value)
{
    static const char name[CYCAN_NAME_BYTES] = {0};
    cycan_store_io_t s = io();
    cycan_store_info_t info;
    uint8_t rec[8];
    cycan_wr_u16(rec, CYCAN_PID_CAN_DATA_BITRATE);
    rec[2] = CYCAN_PTYPE_ENUM;
    rec[3] = 0;
    cycan_wr_u32(rec + 4, value);
    (void)cycan_store_scan(&s, CYCAN_MODEL_CYNCODER, &info);
    CHECK(cycan_store_write(&s, &info, CYCAN_MODEL_CYNCODER, NUM, name, 1, one_rec, rec));
}

void test_boot_data_bitrate(void)
{
    setup(1);
    /* Nothing stored about the bitrate: the catalog default, like the application. */
    CHECK_EQ(fk.can_configs, 1);
    CHECK_EQ(fk.can_bitrate, 1);
    CHECK_EQ(cycan_boot_data_bitrate(&bl), 1);
    /* The stored value (finding 16: not a hard-coded 2 Mbit/s). */
    store_bitrate(0);
    power_cycle(true);
    CHECK_EQ(fk.can_bitrate, 0);
    store_bitrate(3);
    power_cycle(true);
    CHECK_EQ(fk.can_bitrate, 3);
    CHECK_EQ(cycan_boot_num(&bl), NUM);
    /* Out of range, or both copies corrupt: classic. */
    store_bitrate(7);
    power_cycle(true);
    CHECK_EQ(fk.can_bitrate, 0);
    fk.region[0][CYCAN_STORE_HEADER] ^= 1u;
    fk.region[1][CYCAN_STORE_HEADER] ^= 1u;
    power_cycle(true);
    CHECK_EQ(fk.can_bitrate, 0);
    CHECK_EQ(cycan_boot_num(&bl), CYCAN_NUM_UNASSIGNED);
}

void test_boot_presence(void)
{
    cycan_frame_t f;
    cycan_enum_req_t e;
    cycan_enum_rsp_t r;
    cycan_heartbeat_t hb;
    const cycan_frame_t *rf;
    cycan_command_t c;
    cycan_command_rsp_t cr;
    setup(1);
    run_boot_ms(&bl, &now, 1050);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT), 3); /* phase <= 50 ms, then every 500 ms */
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
    CHECK(rf != NULL && rf->id == cycan_id_encode(DT, CYCAN_CLS_SYS_RSP, 0, NUM));
    CHECK(rf != NULL && cycan_dec_heartbeat(rf->data, rf->len, &hb) && hb.state == CYCAN_STATE_BOOTLOADER);

    e.filter = CYCAN_ENUM_FILTER_ALL;
    cycan_enc_enum_req(&f, 0, 0, &e);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 101);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.bootloader && r.num == NUM && r.model == CYCAN_MODEL_CYNCODER);

    /* REBOOT without a valid image stays in the bootloader. */
    c.cmd = CYCAN_CMD_REBOOT;
    c.arg = 0;
    cycan_enc_command(&f, DT, NUM, &c);
    fake_clear(&fk);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 20);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &cr) && cr.status == CYCAN_CMDST_FAILED);
    CHECK_EQ(fk.app_starts, 0);

    /* After an update the heartbeat reports the installed version; REBOOT starts it. */
    happy(CYCAN_FW_CHUNK_FD);
    power_cycle(true);
    fake_clear(&fk);
    run_boot_ms(&bl, &now, 600);
    CHECK(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) >= 1);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
    CHECK(rf != NULL && cycan_dec_heartbeat(rf->data, rf->len, &hb) && hb.fw_major == 1 && hb.fw_minor == 5 && hb.fw_patch == 2);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 20);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &cr) && cr.status == CYCAN_CMDST_OK);
    CHECK_EQ(fk.app_starts, 2);

    /* PROTOCOL 9: once the erase ran, the heartbeat reports 0.0.0. */
    power_cycle(true);
    begin(image_size, cycan_crc32(image, image_size));
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    fake_clear(&fk);
    run_boot_ms(&bl, &now, 600);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
    CHECK(rf != NULL && cycan_dec_heartbeat(rf->data, rf->len, &hb) && hb.fw_major == 0 && hb.fw_minor == 0 && hb.fw_patch == 0);
}

void test_boot_unassigned_silent(void)
{
    cycan_boot_cfg_t cfg = default_cfg(1);
    cycan_fw_begin_t m;
    cycan_frame_t f;
    now = 0;
    fake_init(&fk, 0x42);
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    CHECK_EQ(cycan_boot_num(&bl), CYCAN_NUM_UNASSIGNED);
    run_boot_ms(&bl, &now, 1500);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, 0xFF), 0);
    /* FW to an unassigned bootloader is ignored: assign a number first (PROTOCOL 3.4). */
    m.size = 100;
    m.crc32 = 0;
    cycan_enc_fw_begin(&f, DT, CYCAN_NUM_UNASSIGNED, &m);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 2);
    CHECK_EQ(fk.nsent, 0);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
}

void test_boot_assign_and_silence(void)
{
    cycan_frame_t f;
    cycan_assign_id_t a;
    cycan_enum_rsp_t r;
    cycan_command_t c;
    cycan_param_get_t g;
    cycan_info_req_t ir;
    const cycan_frame_t *rf;
    cycan_boot_cfg_t cfg = default_cfg(1);
    now = 0;
    fake_init(&fk, 0x42);
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    a.uid48 = bl.uid.uid48;
    a.new_num = 7;
    a.persist = true;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.num == 7 && r.bootloader);
    CHECK_EQ(fk.nsent_at_store, 1); /* confirmed before the flash write */
    {
        cycan_store_io_t s = io();
        cycan_store_info_t info;
        CHECK(cycan_store_scan(&s, CYCAN_MODEL_CYNCODER, &info) && info.num == 7);
    }
    run_boot_ms(&bl, &now, 10);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT), 1);

    /* Everything outside the bootloader's set stays unanswered. */
    fake_clear(&fk);
    c.cmd = CYCAN_CMD_SAVE_PARAMS;
    c.arg = 0;
    cycan_enc_command(&f, DT, 7, &c);
    to_boot(&bl, &f);
    c.cmd = CYCAN_CMD_ENTER_BOOTLOADER;
    cycan_enc_command(&f, DT, 7, &c);
    to_boot(&bl, &f);
    g.pid = CYCAN_PID_CAN_DATA_BITRATE;
    cycan_enc_param_get(&f, DT, 7, &g);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    ir.page = 3;
    cycan_enc_info_req(&f, DT, 7, &ir);
    to_boot(&bl, &f);
    cycan_enc_fault_req(&f, DT, 7);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    CHECK_EQ(fk.nsent, 0);
    ir.page = 0;
    cycan_enc_info_req(&f, DT, 7, &ir);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP), 1);
}
