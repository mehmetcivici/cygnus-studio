/* Golden vectors: C encode == TS bytes and decode(TS bytes) == fields, for every message. */
#include <math.h>
#include <string.h>

#include "test.h"
#include "vectors.h"

#include "cycan_vectors.inc"

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static void encode(const vec_msg_t *v, cycan_frame_t *f)
{
    uint8_t dt = v->devtype, n = v->num;
    memset(f, 0xAA, sizeof *f); /* encoders must not depend on a zeroed frame */
    switch (v->kind) {
    case VK_ENUM_REQ: cycan_enc_enum_req(f, dt, n, &v->f.enum_req); break;
    case VK_ASSIGN_ID: cycan_enc_assign_id(f, dt, n, &v->f.assign_id); break;
    case VK_IDENTIFY: cycan_enc_identify(f, dt, n, &v->f.identify); break;
    case VK_INFO_REQ: cycan_enc_info_req(f, dt, n, &v->f.info_req); break;
    case VK_NAME_SET: cycan_enc_name_set(f, dt, n, &v->f.name_set); break;
    case VK_COMMAND: cycan_enc_command(f, dt, n, &v->f.command); break;
    case VK_FAULT_REQ: cycan_enc_fault_req(f, dt, n); break;
    case VK_ESTOP: cycan_enc_estop(f, dt, n); break;
    case VK_HEARTBEAT: cycan_enc_heartbeat(f, dt, n, &v->f.heartbeat); break;
    case VK_INFO_DEVICE: cycan_enc_info_device(f, dt, n, &v->f.info_device); break;
    case VK_INFO_BUILD: cycan_enc_info_build(f, dt, n, &v->f.info_build); break;
    case VK_INFO_BYTES: cycan_enc_info_rsp(f, dt, n, &v->f.info_bytes); break;
    case VK_COMMAND_RSP: cycan_enc_command_rsp(f, dt, n, &v->f.command_rsp); break;
    case VK_FAULT_RSP: cycan_enc_fault_rsp(f, dt, n, &v->f.fault_rsp); break;
    case VK_ENUM_RSP: cycan_enc_enum_rsp(f, dt, &v->f.enum_rsp); break;
    case VK_PARAM_GET: cycan_enc_param_get(f, dt, n, &v->f.param_get); break;
    case VK_PARAM_SET: cycan_enc_param_set(f, dt, n, &v->f.param_set); break;
    case VK_PARAM_VALUE: cycan_enc_param_value(f, dt, n, &v->f.param_value); break;
    case VK_STREAM_CONFIG: cycan_enc_stream_config(f, dt, n, &v->f.stream_config); break;
    case VK_STREAM_START: cycan_enc_stream_start(f, dt, n, &v->f.stream_start); break;
    case VK_STREAM_STOP: cycan_enc_stream_stop(f, dt, n); break;
    case VK_STREAM_DATA: CHECK(cycan_enc_stream_data(f, dt, n, &v->f.stream_data)); break;
    case VK_FW_BEGIN: cycan_enc_fw_begin(f, dt, n, &v->f.fw_begin); break;
    case VK_FW_DATA: CHECK(cycan_enc_fw_data(f, dt, n, &v->f.fw_data)); break;
    case VK_FW_END: cycan_enc_fw_end(f, dt, n); break;
    case VK_FW_ACK: cycan_enc_fw_ack(f, dt, n, &v->f.fw_ack); break;
    case VK_CTRL_SET: cycan_enc_ctrl_set(f, dt, n, &v->f.ctrl_set); break;
    case VK_CTRL_SERVO: cycan_enc_ctrl_servo(f, dt, n, &v->f.ctrl_servo); break;
    case VK_CTRL_TEXT: cycan_enc_ctrl_text(f, dt, n, &v->f.ctrl_text); break;
    }
}

static void check_decode(const vec_msg_t *v)
{
    const uint8_t *d = v->data;
    uint8_t len = v->len;
    switch (v->kind) {
    case VK_ENUM_REQ: {
        cycan_enum_req_t m;
        CHECK(cycan_dec_enum_req(d, len, &m));
        CHECK_EQ(m.filter, v->f.enum_req.filter);
        break;
    }
    case VK_ASSIGN_ID: {
        cycan_assign_id_t m;
        CHECK(cycan_dec_assign_id(d, len, &m));
        CHECK_EQ(m.uid48, v->f.assign_id.uid48);
        CHECK_EQ(m.new_num, v->f.assign_id.new_num);
        CHECK_EQ(m.persist, v->f.assign_id.persist);
        break;
    }
    case VK_IDENTIFY: {
        cycan_identify_t m;
        CHECK(cycan_dec_identify(d, len, &m));
        CHECK_EQ(m.uid_form, v->f.identify.uid_form);
        CHECK_EQ(m.uid48, v->f.identify.uid48);
        CHECK_EQ(m.seconds, v->f.identify.seconds);
        break;
    }
    case VK_INFO_REQ: {
        cycan_info_req_t m;
        CHECK(cycan_dec_info_req(d, len, &m));
        CHECK_EQ(m.page, v->f.info_req.page);
        break;
    }
    case VK_NAME_SET: {
        cycan_name_set_t m;
        CHECK(cycan_dec_name_set(d, len, &m));
        CHECK_EQ(m.page, v->f.name_set.page);
        CHECK(memcmp(m.bytes, v->f.name_set.bytes, 7) == 0);
        break;
    }
    case VK_COMMAND: {
        cycan_command_t m;
        CHECK(cycan_dec_command(d, len, &m));
        CHECK_EQ(m.cmd, v->f.command.cmd);
        CHECK_EQ(m.arg, v->f.command.arg);
        break;
    }
    case VK_FAULT_REQ:
    case VK_STREAM_STOP:
    case VK_FW_END:
        CHECK_EQ(len, 0);
        break;
    case VK_ESTOP:
        CHECK(cycan_dec_estop(d, len));
        break;
    case VK_HEARTBEAT: {
        cycan_heartbeat_t m;
        const cycan_heartbeat_t *e = &v->f.heartbeat;
        CHECK(cycan_dec_heartbeat(d, len, &m));
        CHECK_EQ(m.state, e->state);
        CHECK_EQ(m.unsaved, e->unsaved);
        CHECK_EQ(m.enabled, e->enabled);
        CHECK_EQ(m.warning, e->warning);
        CHECK_EQ(m.identify, e->identify);
        CHECK_EQ(m.fault, e->fault);
        CHECK_EQ(m.uid16, e->uid16);
        CHECK_EQ(m.fw_major, e->fw_major);
        CHECK_EQ(m.fw_minor, e->fw_minor);
        CHECK_EQ(m.fw_patch, e->fw_patch);
        break;
    }
    case VK_INFO_DEVICE: {
        cycan_info_device_t m;
        const cycan_info_device_t *e = &v->f.info_device;
        CHECK(cycan_dec_info_device(d, len, &m));
        CHECK_EQ(m.model, e->model);
        CHECK_EQ(m.hw_rev, e->hw_rev);
        CHECK_EQ(m.proto_major, e->proto_major);
        CHECK_EQ(m.proto_minor, e->proto_minor);
        CHECK_EQ(m.catalog_rev, e->catalog_rev);
        CHECK_EQ(m.bootloader_ver, e->bootloader_ver);
        break;
    }
    case VK_INFO_BUILD: {
        cycan_info_build_t m;
        CHECK(cycan_dec_info_build(d, len, &m));
        CHECK_EQ(m.git_hash, v->f.info_build.git_hash);
        CHECK_EQ(m.build_day, v->f.info_build.build_day);
        CHECK_EQ(m.dirty, v->f.info_build.dirty);
        break;
    }
    case VK_INFO_BYTES: {
        cycan_info_rsp_t m;
        CHECK(cycan_dec_info_rsp(d, len, &m));
        CHECK_EQ(m.page, v->f.info_bytes.page);
        CHECK(memcmp(m.bytes, v->f.info_bytes.bytes, 7) == 0);
        break;
    }
    case VK_COMMAND_RSP: {
        cycan_command_rsp_t m;
        CHECK(cycan_dec_command_rsp(d, len, &m));
        CHECK_EQ(m.cmd, v->f.command_rsp.cmd);
        CHECK_EQ(m.status, v->f.command_rsp.status);
        CHECK_EQ(m.result, v->f.command_rsp.result);
        break;
    }
    case VK_FAULT_RSP: {
        cycan_fault_rsp_t m;
        CHECK(cycan_dec_fault_rsp(d, len, &m));
        CHECK_EQ(m.active, v->f.fault_rsp.active);
        CHECK_EQ(m.sticky, v->f.fault_rsp.sticky);
        CHECK_EQ(m.warn, v->f.fault_rsp.warn);
        break;
    }
    case VK_ENUM_RSP: {
        cycan_enum_rsp_t m;
        CHECK(cycan_dec_enum_rsp(d, len, &m));
        CHECK_EQ(m.uid48, v->f.enum_rsp.uid48);
        CHECK_EQ(m.num, v->f.enum_rsp.num);
        CHECK_EQ(m.conflict, v->f.enum_rsp.conflict);
        CHECK_EQ(m.bootloader, v->f.enum_rsp.bootloader);
        CHECK_EQ(m.model, v->f.enum_rsp.model);
        break;
    }
    case VK_PARAM_GET: {
        cycan_param_get_t m;
        CHECK(cycan_dec_param_get(d, len, &m));
        CHECK_EQ(m.pid, v->f.param_get.pid);
        break;
    }
    case VK_PARAM_SET: {
        cycan_param_set_t m;
        CHECK(cycan_dec_param_set(d, len, &m));
        CHECK_EQ(m.pid, v->f.param_set.pid);
        CHECK_EQ(m.ptype, v->f.param_set.ptype);
        CHECK_EQ(m.value, v->f.param_set.value);
        break;
    }
    case VK_PARAM_VALUE: {
        cycan_param_value_t m;
        CHECK(cycan_dec_param_value(d, len, &m));
        CHECK_EQ(m.pid, v->f.param_value.pid);
        CHECK_EQ(m.ptype, v->f.param_value.ptype);
        CHECK_EQ(m.status, v->f.param_value.status);
        CHECK_EQ(m.value, v->f.param_value.value);
        break;
    }
    case VK_STREAM_CONFIG: {
        cycan_stream_config_t m;
        CHECK(cycan_dec_stream_config(d, len, &m));
        CHECK_EQ(m.slot, v->f.stream_config.slot);
        CHECK_EQ(m.sid, v->f.stream_config.sid);
        break;
    }
    case VK_STREAM_START: {
        cycan_stream_start_t m;
        CHECK(cycan_dec_stream_start(d, len, &m));
        CHECK_EQ(m.period_100us, v->f.stream_start.period_100us);
        break;
    }
    case VK_STREAM_DATA: {
        cycan_stream_data_t m;
        const cycan_stream_data_t *e = &v->f.stream_data;
        uint8_t i;
        CHECK(cycan_dec_stream_data(d, len, &m));
        CHECK_EQ(m.seq, e->seq);
        CHECK_EQ(m.first_slot, e->first_slot);
        CHECK_EQ(m.t_100us, e->t_100us);
        /* FD padding may add trailing zero values beyond the encoded count. */
        CHECK(m.count >= e->count);
        for (i = 0; i < e->count; i++) CHECK_EQ(cycan_f32_bits(m.values[i]), cycan_f32_bits(e->values[i]));
        for (i = e->count; i < m.count; i++) CHECK(m.values[i] == 0.0f);
        break;
    }
    case VK_FW_BEGIN: {
        cycan_fw_begin_t m;
        CHECK(cycan_dec_fw_begin(d, len, &m));
        CHECK_EQ(m.size, v->f.fw_begin.size);
        CHECK_EQ(m.crc32, v->f.fw_begin.crc32);
        break;
    }
    case VK_FW_DATA: {
        cycan_fw_data_t m;
        CHECK(cycan_dec_fw_data(d, len, &m));
        CHECK_EQ(m.offset, v->f.fw_data.offset);
        CHECK(m.len >= v->f.fw_data.len);
        CHECK(memcmp(m.bytes, v->f.fw_data.bytes, v->f.fw_data.len) == 0);
        break;
    }
    case VK_FW_ACK: {
        cycan_fw_ack_t m;
        CHECK(cycan_dec_fw_ack(d, len, &m));
        CHECK_EQ(m.status, v->f.fw_ack.status);
        CHECK_EQ(m.window, v->f.fw_ack.window);
        CHECK_EQ(m.next_offset, v->f.fw_ack.next_offset);
        break;
    }
    case VK_CTRL_SET: {
        cycan_ctrl_set_t m;
        CHECK(cycan_dec_ctrl_set(d, len, &m));
        CHECK_EQ(m.mode, v->f.ctrl_set.mode);
        CHECK_EQ(m.flags, v->f.ctrl_set.flags);
        CHECK_EQ(cycan_f32_bits(m.value), cycan_f32_bits(v->f.ctrl_set.value));
        break;
    }
    case VK_CTRL_SERVO: {
        cycan_ctrl_servo_t m;
        uint8_t i;
        CHECK(cycan_dec_ctrl_servo(d, len, CYCAN_ID_INDEX(v->id), &m));
        CHECK_EQ(m.index, v->f.ctrl_servo.index);
        for (i = 0; i < 4u; i++) CHECK_EQ(m.pulses_us[i], v->f.ctrl_servo.pulses_us[i]);
        break;
    }
    case VK_CTRL_TEXT: {
        cycan_ctrl_text_t m;
        CHECK(cycan_dec_ctrl_text(d, len, &m));
        CHECK_EQ(m.line, v->f.ctrl_text.line);
        CHECK_EQ(m.col, v->f.ctrl_text.col);
        CHECK(strcmp(m.text, v->f.ctrl_text.text) == 0);
        break;
    }
    }
}

void test_vectors_messages(void)
{
    size_t i;
    for (i = 0; i < COUNT(k_vec_msgs); i++) {
        const vec_msg_t *v = &k_vec_msgs[i];
        cycan_frame_t f;
        int before = g_failures;
        encode(v, &f);
        CHECK_EQ(f.id, v->id);
        CHECK_EQ(f.len, v->len);
        CHECK_EQ((f.flags & CYCAN_FRAME_FD) != 0u, v->fd);
        CHECK_EQ((f.flags & CYCAN_FRAME_BRS) != 0u, v->fd);
        CHECK(memcmp(f.data, v->data, v->len) == 0);
        check_decode(v);
        if (g_failures != before) printf("  ^ in vector %s\n", v->name);
    }
    CHECK_EQ(COUNT(k_vec_msgs), 45);
}

void test_vectors_uid_crc(void)
{
    size_t i;
    for (i = 0; i < COUNT(k_vec_uids); i++) {
        cycan_uid_t u;
        cycan_uid_derive(k_vec_uids[i].uid96, &u);
        CHECK_EQ(u.uid48, k_vec_uids[i].uid48);
        CHECK_EQ(u.uid16, k_vec_uids[i].uid16);
        CHECK_EQ(u.hash10, k_vec_uids[i].hash10);
        CHECK_EQ(u.enum_delay_ms, k_vec_uids[i].enum_delay_ms);
    }
    for (i = 0; i < COUNT(k_vec_crcs); i++) {
        const char *s = k_vec_crcs[i].ascii;
        CHECK_EQ(cycan_crc32((const uint8_t *)s, strlen(s)), k_vec_crcs[i].crc32);
    }
    /* Running CRC over split input equals the one-shot CRC. */
    CHECK_EQ(cycan_crc32_update(cycan_crc32((const uint8_t *)"1234", 4), (const uint8_t *)"56789", 5), 0xCBF43926u);
}

static float kv(const vec_status_t *s, const char *key)
{
    uint8_t i;
    for (i = 0; i < s->count; i++)
        if (strcmp(s->values[i].key, key) == 0) return s->values[i].value;
    return NAN;
}

/* The catalog layouts of these frames (cycan_catalog.h comments), packed with the helpers. */
void test_vectors_status_frames(void)
{
    size_t i;
    for (i = 0; i < COUNT(k_vec_status); i++) {
        const vec_status_t *s = &k_vec_status[i];
        uint8_t d[8];
        memset(d, 0, sizeof d);
        if (strcmp(s->name, "esc20a_fast") == 0) {
            cycan_wr_f32(d, kv(s, "velocity"));
            cycan_wr_u16(d + 4, (uint16_t)cycan_scale_round(kv(s, "phase.current"), 0.01f, 0, -32768, 32767));
            cycan_wr_u16(d + 6, (uint16_t)cycan_scale_round(kv(s, "duty"), 0.0001f, 0, -32768, 32767));
        } else if (strcmp(s->name, "esc20a_position_supply") == 0) {
            cycan_wr_f32(d, kv(s, "position"));
            cycan_wr_u16(d + 4, (uint16_t)cycan_scale_round(kv(s, "bus.voltage"), 0.01f, 0, 0, 65535));
            cycan_wr_u16(d + 6, (uint16_t)cycan_scale_round(kv(s, "bus.current"), 0.01f, 0, -32768, 32767));
        } else if (strcmp(s->name, "cyncoder_abs_magnet") == 0) {
            cycan_wr_f32(d, kv(s, "abs.position"));
            cycan_put_bits(d + 4, 2, 0, 12, (uint32_t)cycan_scale_round(kv(s, "raw.angle"), 1, 0, 0, 4095));
            cycan_put_bits(d + 4, 2, 12, 2, (uint32_t)cycan_scale_round(kv(s, "magnet.status"), 1, 0, 0, 3));
            d[6] = (uint8_t)cycan_scale_round(kv(s, "magnet.agc"), 1, 0, 0, 255);
            d[7] = (uint8_t)cycan_scale_round(kv(s, "temp"), 1, 0, -128, 127);
        } else if (strcmp(s->name, "gyro_quaternion") == 0) {
            const char *k[4] = {"quat.w", "quat.x", "quat.y", "quat.z"};
            int j;
            for (j = 0; j < 4; j++)
                cycan_wr_u16(d + 2 * j, (uint16_t)cycan_scale_round(kv(s, k[j]), 0.00006103516f, 0, -32768, 32767));
        } else if (strcmp(s->name, "pdh_large_totals") == 0) {
            cycan_wr_u16(d, (uint16_t)cycan_scale_round(kv(s, "input.voltage"), 0.01f, 0, 0, 65535));
            cycan_wr_u16(d + 2, (uint16_t)cycan_scale_round(kv(s, "total.current"), 0.01f, 0, 0, 65535));
            cycan_wr_u16(d + 4, (uint16_t)cycan_scale_round(kv(s, "power"), 1, 0, 0, 65535));
            d[6] = (uint8_t)cycan_scale_round(kv(s, "fuse.mask"), 1, 0, 0, 255);
            d[7] = (uint8_t)cycan_scale_round(kv(s, "temp"), 1, 0, -128, 127);
        } else {
            printf("  unknown status vector %s\n", s->name);
            CHECK(0);
            continue;
        }
        if (memcmp(d, s->data, 8) != 0) printf("  ^ status vector %s\n", s->name);
        CHECK(memcmp(d, s->data, 8) == 0);
    }
    /* Rounding like JS Math.round (halves toward +inf) and saturation. */
    CHECK_EQ((uint32_t)cycan_scale_round(2.5f, 1, 0, -100, 100), 3);
    CHECK_EQ((uint32_t)cycan_scale_round(-2.5f, 1, 0, -100, 100), (uint32_t)-2);
    CHECK_EQ((uint32_t)cycan_scale_round(-0.5f, 1, 0, -100, 100), 0);
    CHECK_EQ((uint32_t)cycan_scale_round(1e9f, 1, 0, -100, 100), 100);
    CHECK_EQ((uint32_t)cycan_scale_round(NAN, 1, 0, -100, 100), 0);
}

void test_vectors_cyfw(void)
{
    cycan_cyfw_header_t h;
    uint8_t hdr[CYCAN_CYFW_HEADER_SIZE];
    const vec_cyfw_meta_t *m = &k_vec_cyfw_meta;
    memset(&h, 0, sizeof h);
    h.model = m->model;
    h.hw_rev_min = m->hw_rev_min;
    h.hw_rev_max = m->hw_rev_max;
    h.fw_major = m->fw_major;
    h.fw_minor = m->fw_minor;
    h.fw_patch = m->fw_patch;
    h.payload_size = (uint32_t)sizeof k_vec_cyfw_payload;
    h.payload_crc32 = cycan_crc32(k_vec_cyfw_payload, sizeof k_vec_cyfw_payload);
    h.catalog_rev = m->catalog_rev;
    h.git_hash = m->git_hash;
    h.build_day = m->build_day;
    strcpy(h.name, m->name);
    cycan_cyfw_encode_header(hdr, &h);
    CHECK(memcmp(hdr, k_vec_cyfw_file, CYCAN_CYFW_HEADER_SIZE) == 0);
    CHECK_EQ(sizeof k_vec_cyfw_file, CYCAN_CYFW_HEADER_SIZE + sizeof k_vec_cyfw_payload);

    memset(&h, 0, sizeof h);
    CHECK_EQ(cycan_cyfw_check_header(k_vec_cyfw_file, 3, 2, &h), CYCAN_CYFW_OK);
    CHECK_EQ(h.payload_size, 16);
    CHECK_EQ(h.git_hash, 0x1234abcdu);
    CHECK(strcmp(h.name, "cyncoder-1.5.0") == 0);
    CHECK_EQ(cycan_cyfw_check_header(k_vec_cyfw_file, 1, 2, NULL), CYCAN_CYFW_WRONG_MODEL);
    CHECK_EQ(cycan_cyfw_check_header(k_vec_cyfw_file, 3, 3, NULL), CYCAN_CYFW_WRONG_HW_REV);
    memcpy(hdr, k_vec_cyfw_file, sizeof hdr);
    hdr[33] ^= 1u;
    CHECK_EQ(cycan_cyfw_check_header(hdr, 3, 2, NULL), CYCAN_CYFW_BAD_HEADER_CRC);
    hdr[0] = 'X';
    CHECK_EQ(cycan_cyfw_check_header(hdr, 3, 2, NULL), CYCAN_CYFW_BAD_MAGIC);
}

void test_codec_ids_and_lengths(void)
{
    cycan_id_fields_t f;
    uint32_t id = cycan_id_encode(7, CYCAN_CLS_PARAM_REQ, 1, 5);
    cycan_id_decode(id, &f);
    CHECK_EQ(f.devtype, 7);
    CHECK_EQ(f.mfr, CYCAN_MFR);
    CHECK_EQ(f.cls, CYCAN_CLS_PARAM_REQ);
    CHECK_EQ(f.index, 1);
    CHECK_EQ(f.num, 5);
    /* acceptsFrame: own address, own type broadcast, global broadcast. */
    CHECK(cycan_accepts(id, 7, 5));
    CHECK(!cycan_accepts(id, 7, 6));
    CHECK(cycan_accepts(cycan_id_encode(7, CYCAN_CLS_PARAM_REQ, 1, 0), 7, 6));
    CHECK(!cycan_accepts(cycan_id_encode(2, CYCAN_CLS_PARAM_REQ, 1, 0), 7, 6));
    CHECK(cycan_accepts(cycan_id_encode(0, CYCAN_CLS_SYS_REQ, 0, 0), 7, 6));
    CHECK(!cycan_accepts(cycan_id_encode(0, CYCAN_CLS_SYS_REQ, 0, 1), 7, 6));
    /* Board-to-host classes, legacy classes, other MFR are never accepted. */
    CHECK(!cycan_accepts(cycan_id_encode(7, CYCAN_CLS_SYS_RSP, 0, 5), 7, 5));
    CHECK(!cycan_accepts(cycan_id_encode(7, 0x01, 0, 5), 7, 5));
    CHECK(!cycan_accepts(cycan_id_encode_mfr(7, 9, CYCAN_CLS_SYS_REQ, 0, 5), 7, 5));
    CHECK(!cycan_accepts(0x20000000u, 0, 0));

    CHECK_EQ(cycan_fd_round_up(9), 12);
    CHECK_EQ(cycan_fd_round_up(64), 64);
    CHECK_EQ(cycan_fd_round_up(65), 0);
    CHECK_EQ(cycan_fd_len_to_dlc(20), 11);
    CHECK_EQ(cycan_fd_dlc_to_len(15), 64);
}
