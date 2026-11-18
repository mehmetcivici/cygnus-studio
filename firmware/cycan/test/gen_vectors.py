#!/usr/bin/env python3
"""Converts packages/protocol/test/vectors/cycan-vectors.json into C initializers.

Usage: gen_vectors.py <cycan-vectors.json> <out.inc>
Standard library only. The output is included by test/test_codec.c after test/vectors.h,
which declares the vec_* types used here.
"""

import json
import struct
import sys

KINDS = {
    "enumReq": "VK_ENUM_REQ",
    "assignId": "VK_ASSIGN_ID",
    "identify": "VK_IDENTIFY",
    "identifyUid": "VK_IDENTIFY",
    "infoReq": "VK_INFO_REQ",
    "nameSet": "VK_NAME_SET",
    "command": "VK_COMMAND",
    "faultReq": "VK_FAULT_REQ",
    "estop": "VK_ESTOP",
    "heartbeat": "VK_HEARTBEAT",
    "commandRsp": "VK_COMMAND_RSP",
    "faultRsp": "VK_FAULT_RSP",
    "enumRsp": "VK_ENUM_RSP",
    "paramGet": "VK_PARAM_GET",
    "paramSet": "VK_PARAM_SET",
    "paramValue": "VK_PARAM_VALUE",
    "streamConfig": "VK_STREAM_CONFIG",
    "streamStart": "VK_STREAM_START",
    "streamStop": "VK_STREAM_STOP",
    "streamData": "VK_STREAM_DATA",
    "fwBegin": "VK_FW_BEGIN",
    "fwData": "VK_FW_DATA",
    "fwEnd": "VK_FW_END",
    "fwAck": "VK_FW_ACK",
    "ctrlSet": "VK_CTRL_SET",
    "ctrlServo": "VK_CTRL_SERVO",
    "ctrlText": "VK_CTRL_TEXT",
}

PTYPE_I32, PTYPE_F32 = 1, 2


def c_bool(v):
    return "true" if v else "false"


def c_float(v):
    # Hex float literals are exact and valid C99.
    return float(v).hex() + "f"


def c_bytes(hexstr):
    b = bytes.fromhex(hexstr)
    return "{" + ", ".join("0x%02x" % x for x in b) + "}" if b else "{0}"


def c_str(s):
    out = []
    for ch in s:
        o = ord(ch)
        if ch in '"\\':
            out.append("\\" + ch)
        elif 0x20 <= o < 0x7F:
            out.append(ch)
        else:
            out.append("\\x%02x" % o)
    return '"' + "".join(out) + '"'


def raw_value(ptype, value):
    if ptype == PTYPE_F32:
        return struct.unpack("<I", struct.pack("<f", value))[0]
    if ptype == PTYPE_I32:
        return int(value) & 0xFFFFFFFF
    return int(value)


def fields(m, extra):
    f = m["fields"]
    k = m["kind"]
    if k == "enumReq":
        return ".enum_req = {%d}" % f["filter"]
    if k == "assignId":
        return ".assign_id = {0x%xull, %d, %s}" % (f["uid48"], f["newNum"], c_bool(f["persist"]))
    if k == "identify":
        return ".identify = {false, 0, %d}" % f["seconds"]
    if k == "identifyUid":
        return ".identify = {true, 0x%xull, %d}" % (f["uid48"], f["seconds"])
    if k == "infoReq":
        return ".info_req = {%d}" % f["page"]
    if k == "nameSet":
        return ".name_set = {%d, %s}" % (f["page"], c_bytes(f["bytes"]))
    if k == "command":
        return ".command = {%d, %du}" % (f["cmd"], f["arg"])
    if k in ("faultReq", "estop", "streamStop", "fwEnd"):
        return ".none = 0"
    if k == "heartbeat":
        return ".heartbeat = {%d, %s, %s, %s, %s, %d, %d, %d, %d, %d}" % (
            f["state"], c_bool(f["unsaved"]), c_bool(f["enabled"]), c_bool(f["warning"]), c_bool(f["identify"]),
            f["fault"], f["uid16"], f["fwMajor"], f["fwMinor"], f["fwPatch"])
    if k == "infoRsp":
        s = f["section"]
        if s == "device":
            return ".info_device = {%d, %d, %d, %d, %d, %d}" % (
                f["model"], f["hwRev"], f["protoMajor"], f["protoMinor"], f["catalogRev"], f["bootloaderVer"])
        if s == "build":
            return ".info_build = {0x%xu, %d, %s}" % (f["gitHash"], f["buildDay"], c_bool(f["dirty"]))
        return ".info_bytes = {%d, %s}" % (f["page"], c_bytes(f["bytes"]))
    if k == "commandRsp":
        return ".command_rsp = {%d, %d, %du}" % (f["cmd"], f["status"], f["result"])
    if k == "faultRsp":
        return ".fault_rsp = {%d, %d, %d}" % (f["active"], f["sticky"], f["warn"])
    if k == "enumRsp":
        return ".enum_rsp = {0x%xull, %d, %s, %s, %d}" % (
            f["uid48"], f["num"], c_bool(f["conflict"]), c_bool(f["bootloader"]), f["model"])
    if k == "paramGet":
        return ".param_get = {%d}" % f["pid"]
    if k == "paramSet":
        return ".param_set = {%d, %d, 0x%08xu}" % (f["pid"], f["ptype"], raw_value(f["ptype"], f["value"]))
    if k == "paramValue":
        return ".param_value = {%d, %d, %d, 0x%08xu}" % (
            f["pid"], f["ptype"], f["status"], raw_value(f["ptype"], f["value"]))
    if k == "streamConfig":
        return ".stream_config = {%d, %d}" % (f["slot"], f["sid"])
    if k == "streamStart":
        return ".stream_start = {%d}" % f["period100us"]
    if k == "streamData":
        vals = ", ".join(c_float(v) for v in f["values"])
        return ".stream_data = {%d, %d, %d, %d, {%s}}" % (f["seq"], f["firstSlot"], f["t100us"], len(f["values"]), vals)
    if k == "fwBegin":
        return ".fw_begin = {%du, 0x%08xu}" % (f["size"], f["crc32"])
    if k == "fwData":
        sym = "k_fw_bytes_%d" % len(extra)
        extra.append("static const uint8_t %s[] = %s;" % (sym, c_bytes(f["bytes"])))
        return ".fw_data = {%du, %d, %s}" % (f["offset"], len(bytes.fromhex(f["bytes"])), sym)
    if k == "fwAck":
        return ".fw_ack = {%d, %d, %du}" % (f["status"], f["window"], f["nextOffset"])
    if k == "ctrlSet":
        return ".ctrl_set = {%d, %d, %s}" % (f["mode"], f["flags"], c_float(f["value"]))
    if k == "ctrlServo":
        return ".ctrl_servo = {%d, {%s}}" % (f["index"], ", ".join(str(p) for p in f["pulsesUs"]))
    if k == "ctrlText":
        return ".ctrl_text = {%d, %d, %s}" % (f["line"], f["col"], c_str(f["text"]))
    raise SystemExit("gen_vectors: unknown kind " + k)


def kind_of(m):
    if m["kind"] == "infoRsp":
        return {"device": "VK_INFO_DEVICE", "build": "VK_INFO_BUILD"}.get(m["fields"]["section"], "VK_INFO_BYTES")
    return KINDS[m["kind"]]


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as fh:
        v = json.load(fh)
    if v.get("format") != "cycan-vectors" or v.get("version") != 1:
        raise SystemExit("gen_vectors: unexpected vector file format")

    extra = []
    rows = []
    for m in v["messages"]:
        data = bytes.fromhex(m["data"])
        rows.append("    {%s, %s, %d, %d, 0x%08xu, %d, %s, %s, {%s}}," % (
            c_str(m["name"]), kind_of(m), m["addr"]["devType"], m["addr"]["num"], int(m["id"], 16), len(data),
            c_bool(m["fd"]), c_bytes(m["data"]), fields(m, extra)))

    out = [
        "/* Generated by test/gen_vectors.py from packages/protocol/test/vectors/cycan-vectors.json. Do not edit. */",
        "",
    ]
    out += extra
    out += ["", "static const vec_msg_t k_vec_msgs[] = {"] + rows + ["};", ""]

    out.append("static const vec_uid_t k_vec_uids[] = {")
    for u in v["uid"]:
        out.append("    {%s, 0x%xull, %d, %d, %d}," % (c_bytes(u["uid96"]), u["uid48"], u["uid16"], u["hash10"], u["enumDelayMs"]))
    out += ["};", ""]

    out.append("static const vec_crc_t k_vec_crcs[] = {")
    for c in v["crc32"]:
        out.append("    {%s, %su}," % (c_str(c["ascii"]), c["crc32"]))
    out += ["};", ""]

    out.append("static const vec_status_t k_vec_status[] = {")
    for s in v["statusFrames"]:
        vals = ", ".join("{%s, %s}" % (c_str(k), c_float(x)) for k, x in s["values"].items())
        out.append("    {%s, %d, %d, %s, %d, {%s}}," % (
            c_str(s["name"]), s["model"], s["frame"], c_bytes(s["data"]), len(s["values"]), vals))
    out += ["};", ""]

    cy = v["cyfw"]
    meta = cy["meta"]
    out.append("static const uint8_t k_vec_cyfw_payload[] = %s;" % c_bytes(cy["payload"]))
    out.append("static const uint8_t k_vec_cyfw_file[] = %s;" % c_bytes(cy["file"]))
    out.append("static const vec_cyfw_meta_t k_vec_cyfw_meta = {%d, %d, %d, %d, %d, %d, %d, 0x%xu, %d, %s};" % (
        meta["model"], meta["hwRevMin"], meta["hwRevMax"], meta["fwMajor"], meta["fwMinor"], meta["fwPatch"],
        meta["catalogRev"], meta["gitHash"], meta["buildDay"], c_str(meta["name"])))
    out.append("")

    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))


if __name__ == "__main__":
    main()
