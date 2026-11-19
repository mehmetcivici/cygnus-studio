#include <stdio.h>

#include "test.h"

int g_checks;
int g_failures;

#define TESTS(X)                        \
    X(test_codec_ids_and_lengths)       \
    X(test_vectors_messages)            \
    X(test_vectors_uid_crc)             \
    X(test_vectors_status_frames)       \
    X(test_vectors_cyfw)                \
    X(test_node_boot_and_enum)          \
    X(test_node_enum_filter_and_retry)  \
    X(test_node_unassigned_is_silent)   \
    X(test_node_assign_id)              \
    X(test_node_heartbeat_timing)       \
    X(test_node_conflict)               \
    X(test_node_conflict_from_enum_rsp) \
    X(test_node_param_statuses)         \
    X(test_node_save_reboot_defaults)   \
    X(test_node_status_periods)         \
    X(test_node_stream_fd_and_classic)  \
    X(test_node_ctrl_timeout)           \
    X(test_node_ctrl_timeout_when_neutral) \
    X(test_node_neutral_first)          \
    X(test_node_broadcast_ctrl)         \
    X(test_node_estop)                  \
    X(test_node_estop_order)            \
    X(test_node_commands)               \
    X(test_node_moving_abort)           \
    X(test_node_info_and_misc)          \
    X(test_node_tx_queue)               \
    X(test_node_cyncoder_table)         \
    X(test_node_bad_table)              \
    X(test_node_boot_heartbeat)         \
    X(test_node_assign_while_driving)   \
    X(test_node_load_saved_and_unsaved) \
    X(test_node_store_power_cut)        \
    X(test_node_store_both_corrupt)     \
    X(test_node_time_wrap)              \
    X(test_node_stream_classic_and_rounding) \
    X(test_boot_happy_classic)          \
    X(test_boot_happy_fd)               \
    X(test_boot_signed_image)           \
    X(test_boot_data_length)            \
    X(test_boot_races)                  \
    X(test_boot_recovery_window)        \
    X(test_boot_data_bitrate)           \
    X(test_boot_out_of_order)           \
    X(test_boot_bad_crc)                \
    X(test_boot_wrong_image)            \
    X(test_boot_presence)               \
    X(test_boot_unassigned_silent)      \
    X(test_boot_assign_and_silence)

#define DECLARE(name) void name(void);
TESTS(DECLARE)

#define ENTRY(name) {#name, name},
static const test_case_t k_tests[] = {TESTS(ENTRY)};

int main(void)
{
    size_t i, n = sizeof k_tests / sizeof k_tests[0];
    int passed = 0;
    for (i = 0; i < n; i++) {
        int before = g_failures;
        k_tests[i].fn();
        if (g_failures == before) {
            passed++;
            printf("PASS %s\n", k_tests[i].name);
        } else {
            printf("FAIL %s\n", k_tests[i].name);
        }
    }
    printf("\n%d/%d tests passed, %d checks, %d failed checks\n", passed, (int)n, g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
