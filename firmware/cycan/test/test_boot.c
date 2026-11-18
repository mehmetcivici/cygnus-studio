/* Bootloader: FW update state machine, image checks, bootloader presence on the bus. */
#include <string.h>

#include "fake.h"
#include "test.h"

#define DT CYCAN_CYNCODER_DEVTYPE
#define NUM 4u
#define PAYLOAD 1003u

static fake_t fk;
static cycan_boot_t bl;
static uint32_t now;
static uint8_t image[CYCAN_CYFW_HEADER_SIZE + PAYLOAD];

static void build_image(uint8_t model, uint8_t hw_min, uint8_t hw_max)
{
    cycan_cyfw_header_t h;
    uint32_t i;
    for (i = 0; i < PAYLOAD; i++) image[CYCAN_CYFW_HEADER_SIZE + i] = (uint8_t)(i * 7u + 3u);
    memset(&h, 0, sizeof h);
    h.model = model;
    h.hw_rev_min = hw_min;
    h.hw_rev_max = hw_max;
    h.fw_major = 1;
    h.fw_minor = 5;
    h.fw_patch = 2;
    h.payload_size = PAYLOAD;
    h.payload_crc32 = cycan_crc32(image + CYCAN_CYFW_HEADER_SIZE, PAYLOAD);
    h.catalog_rev = 1;
    strcpy(h.name, "cyncoder-test");
    cycan_cyfw_encode_header(image, &h);
}

static void setup(uint8_t hw_rev)
{
    cycan_boot_cfg_t cfg;
    now = 0;
    fake_init(&fk, 0x42);
    cfg.model = CYCAN_MODEL_CYNCODER;
    cfg.devtype = DT;
    cfg.hw_rev = hw_rev;
    cfg.bootloader_ver = 3;
    cfg.catalog_rev = 1;
    cfg.num = NUM;
    cfg.window = 0;
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    build_image(CYCAN_MODEL_CYNCODER, 1, 2);
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
    uint32_t left = (uint32_t)sizeof image - off;
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

/* Sends the image from `from`, optionally dropping the chunk at index `drop`. */
static void send_all(uint8_t chunk, uint32_t from, int drop)
{
    uint32_t off;
    int k = 0;
    for (off = from; off < sizeof image; off += chunk, k++)
        if (k != drop) data(off, chunk);
}

static void happy(uint8_t chunk)
{
    cycan_fw_ack_t a;
    setup(1);
    CHECK(!cycan_boot_image_valid(&bl));
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    CHECK_EQ(acks(CYCAN_FWST_BUSY), 1);
    CHECK_EQ(acks(CYCAN_FWST_OK), 1);
    CHECK(last_ack(&a) && a.window == CYCAN_FW_WINDOW_DEFAULT && a.next_offset == 0);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_RECEIVE);
    fake_clear(&fk);
    send_all(chunk, 0, -1);
    {
        uint32_t frames = ((uint32_t)sizeof image + chunk - 1u) / chunk;
        CHECK_EQ(acks(CYCAN_FWST_OK), frames / CYCAN_FW_WINDOW_DEFAULT);
        CHECK(last_ack(&a) && a.next_offset == (frames / CYCAN_FW_WINDOW_DEFAULT) * CYCAN_FW_WINDOW_DEFAULT * chunk);
    }
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK && a.next_offset == sizeof image);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_DONE);
    CHECK(memcmp(fk.flash, image, sizeof image) == 0);
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
    /* A repeated END (lost ACK) is answered OK again. */
    fake_clear(&fk);
    end();
    {
        cycan_fw_ack_t a;
        CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
    }
}

void test_boot_out_of_order(void)
{
    cycan_fw_ack_t a;
    const int drop = 20;
    setup(2);
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    fake_clear(&fk);
    /* Chunk 20 is lost; the next 12 in-flight frames are stray: a single BAD_OFFSET. */
    send_all(CYCAN_FW_CHUNK_CLASSIC, 0, drop);
    CHECK(acks(CYCAN_FWST_BAD_OFFSET) >= 1);
    {
        const cycan_frame_t *f = NULL;
        int i;
        for (i = 0; i < fk.nsent && f == NULL; i++)
            if (cycan_dec_fw_ack(fk.sent[i].data, fk.sent[i].len, &a) && a.status == CYCAN_FWST_BAD_OFFSET) f = &fk.sent[i];
        CHECK(f != NULL && a.next_offset == (uint32_t)drop * CYCAN_FW_CHUNK_CLASSIC);
    }
    /* Stray frames are rate limited to one reply per window. */
    CHECK(acks(CYCAN_FWST_BAD_OFFSET) <= (int)((sizeof image / CYCAN_FW_CHUNK_CLASSIC) / CYCAN_FW_WINDOW_DEFAULT) + 1);
    /* END before everything arrived. */
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_OFFSET && a.next_offset == (uint32_t)drop * CYCAN_FW_CHUNK_CLASSIC);
    /* Host resumes from next_offset. */
    send_all(CYCAN_FW_CHUNK_CLASSIC, a.next_offset, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
    CHECK(memcmp(fk.flash, image, sizeof image) == 0);

    /* After BAD_OFFSET the window restarts: resuming at next_offset, the first OK comes
     * after exactly `window` good frames. */
    {
        uint32_t resume = (uint32_t)drop * CYCAN_FW_CHUNK_CLASSIC, off;
        int k;
        setup(2);
        begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
        for (k = 0, off = 0; k < drop; k++, off += CYCAN_FW_CHUNK_CLASSIC) data(off, CYCAN_FW_CHUNK_CLASSIC);
        data(off + CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC); /* stray */
        fake_clear(&fk);
        for (k = 0; k < (int)CYCAN_FW_WINDOW_DEFAULT - 1; k++) data(resume + (uint32_t)k * CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC);
        CHECK_EQ(acks(CYCAN_FWST_OK), 0);
        data(resume + (CYCAN_FW_WINDOW_DEFAULT - 1u) * CYCAN_FW_CHUNK_CLASSIC, CYCAN_FW_CHUNK_CLASSIC);
        CHECK_EQ(acks(CYCAN_FWST_OK), 1);
        send_all(CYCAN_FW_CHUNK_CLASSIC, resume + CYCAN_FW_WINDOW_DEFAULT * CYCAN_FW_CHUNK_CLASSIC, -1);
        fake_clear(&fk);
        end();
        CHECK(last_ack(&a) && a.status == CYCAN_FWST_OK);
    }
}

void test_boot_bad_crc(void)
{
    cycan_fw_ack_t a;
    setup(1);
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image) ^ 1u);
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_CRC);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    run_boot_ms(&bl, &now, 20);
    CHECK_EQ(fk.app_starts, 0);

    /* File CRC right but the payload does not match the header's payload CRC. */
    image[CYCAN_CYFW_HEADER_SIZE + 10] ^= 0xFFu;
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    fake_clear(&fk);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    CHECK(!cycan_boot_image_valid(&bl));
}

void test_boot_wrong_image(void)
{
    cycan_fw_ack_t a;
    setup(1);
    build_image(CYCAN_MODEL_ESC20A, 1, 2);
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);
    CHECK_EQ(cycan_boot_state(&bl), CYCAN_BOOT_IDLE);
    data(122, CYCAN_FW_CHUNK_FD);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);

    /* Hardware revision outside the image's range. */
    setup(3);
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    fake_clear(&fk);
    send_all(CYCAN_FW_CHUNK_FD, 0, -1);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);

    /* Impossible sizes are refused at BEGIN. */
    setup(1);
    fake_clear(&fk);
    begin(FAKE_FLASH_SIZE + 1u, 0);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    begin(10, 0);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_BAD_IMAGE);
    /* Header size field disagreeing with BEGIN size. */
    begin((uint32_t)sizeof image + 8u, 0);
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_FD);
    data(61, CYCAN_FW_CHUNK_FD);
    CHECK_EQ(acks(CYCAN_FWST_BAD_IMAGE), 1);

    /* DATA / END without BEGIN. */
    setup(1);
    fake_clear(&fk);
    data(0, CYCAN_FW_CHUNK_CLASSIC);
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);
    end();
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_WRONG_STATE);

    /* Flash failure while erasing. */
    fk.flash_fail = true;
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    CHECK(last_ack(&a) && a.status == CYCAN_FWST_FLASH_ERROR);
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
    {
        cycan_boot_cfg_t cfg = bl.cfg; /* power cycle: flash keeps the new image */
        cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    }
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

    /* PROTOCOL 9: once BEGIN erased the image, the heartbeat reports 0.0.0. */
    {
        cycan_boot_cfg_t cfg = bl.cfg;
        cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    }
    begin((uint32_t)sizeof image, cycan_crc32(image, sizeof image));
    fake_clear(&fk);
    run_boot_ms(&bl, &now, 600);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
    CHECK(rf != NULL && cycan_dec_heartbeat(rf->data, rf->len, &hb) && hb.fw_major == 0 && hb.fw_minor == 0 && hb.fw_patch == 0);
}

void test_boot_unassigned_silent(void)
{
    cycan_boot_cfg_t cfg;
    setup(1);
    cfg = bl.cfg;
    cfg.num = CYCAN_NUM_UNASSIGNED;
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    run_boot_ms(&bl, &now, 1500);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, 0xFF), 0);
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
    cycan_boot_cfg_t cfg;
    setup(1);
    cfg = bl.cfg;
    cfg.num = CYCAN_NUM_UNASSIGNED;
    cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);
    a.uid48 = bl.uid.uid48;
    a.new_num = 7;
    a.persist = true;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_boot(&bl, &f);
    run_boot_ms(&bl, &now, 1);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.num == 7 && r.bootloader);
    CHECK_EQ(fk.saved_num, 7);
    CHECK_EQ(fk.nsent_at_write[0], 1);
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
