/* Types for the generated golden vector tables (test/cycan_vectors.inc). */
#ifndef CYCAN_VECTORS_H
#define CYCAN_VECTORS_H

#include "cycan_codec.h"

typedef enum {
    VK_ENUM_REQ,
    VK_ASSIGN_ID,
    VK_IDENTIFY,
    VK_INFO_REQ,
    VK_NAME_SET,
    VK_COMMAND,
    VK_FAULT_REQ,
    VK_ESTOP,
    VK_HEARTBEAT,
    VK_INFO_DEVICE,
    VK_INFO_BUILD,
    VK_INFO_BYTES,
    VK_COMMAND_RSP,
    VK_FAULT_RSP,
    VK_ENUM_RSP,
    VK_PARAM_GET,
    VK_PARAM_SET,
    VK_PARAM_VALUE,
    VK_STREAM_CONFIG,
    VK_STREAM_START,
    VK_STREAM_STOP,
    VK_STREAM_DATA,
    VK_FW_BEGIN,
    VK_FW_DATA,
    VK_FW_END,
    VK_FW_ACK,
    VK_CTRL_SET,
    VK_CTRL_SERVO,
    VK_CTRL_TEXT
} vec_kind_t;

typedef struct {
    const char *name;
    vec_kind_t kind;
    uint8_t devtype;
    uint8_t num;
    uint32_t id;
    uint8_t len;
    bool fd;
    uint8_t data[64];
    union {
        int none;
        cycan_enum_req_t enum_req;
        cycan_assign_id_t assign_id;
        cycan_identify_t identify;
        cycan_info_req_t info_req;
        cycan_name_set_t name_set;
        cycan_command_t command;
        cycan_heartbeat_t heartbeat;
        cycan_info_device_t info_device;
        cycan_info_build_t info_build;
        cycan_info_rsp_t info_bytes;
        cycan_command_rsp_t command_rsp;
        cycan_fault_rsp_t fault_rsp;
        cycan_enum_rsp_t enum_rsp;
        cycan_param_get_t param_get;
        cycan_param_set_t param_set;
        cycan_param_value_t param_value;
        cycan_stream_config_t stream_config;
        cycan_stream_start_t stream_start;
        cycan_stream_data_t stream_data;
        cycan_fw_begin_t fw_begin;
        cycan_fw_data_t fw_data;
        cycan_fw_ack_t fw_ack;
        cycan_ctrl_set_t ctrl_set;
        cycan_ctrl_servo_t ctrl_servo;
        cycan_ctrl_text_t ctrl_text;
    } f;
} vec_msg_t;

typedef struct {
    uint8_t uid96[12];
    uint64_t uid48;
    uint16_t uid16;
    uint16_t hash10;
    uint8_t enum_delay_ms;
} vec_uid_t;

typedef struct {
    const char *ascii;
    uint32_t crc32;
} vec_crc_t;

typedef struct {
    const char *key;
    float value;
} vec_kv_t;

typedef struct {
    const char *name;
    uint8_t model;
    uint8_t frame;
    uint8_t data[8];
    uint8_t count;
    vec_kv_t values[8];
} vec_status_t;

typedef struct {
    uint8_t model, hw_rev_min, hw_rev_max, fw_major, fw_minor, fw_patch;
    uint16_t catalog_rev;
    uint32_t git_hash;
    uint16_t build_day;
    const char *name;
} vec_cyfw_meta_t;

#endif
