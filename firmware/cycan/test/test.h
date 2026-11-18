/* Minimal host test harness: CHECK macros count checks and failures per test. */
#ifndef CYCAN_TEST_H
#define CYCAN_TEST_H

#include <stdio.h>

extern int g_checks;
extern int g_failures;

#define CHECK(c)                                                                \
    do {                                                                        \
        g_checks++;                                                             \
        if (!(c)) {                                                             \
            g_failures++;                                                       \
            printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #c);     \
        }                                                                       \
    } while (0)

#define CHECK_EQ(a, b)                                                                                  \
    do {                                                                                                \
        unsigned long long va_ = (unsigned long long)(a), vb_ = (unsigned long long)(b);               \
        g_checks++;                                                                                     \
        if (va_ != vb_) {                                                                               \
            g_failures++;                                                                               \
            printf("  %s:%d: %s == %s failed (0x%llx != 0x%llx)\n", __FILE__, __LINE__, #a, #b, va_, vb_); \
        }                                                                                               \
    } while (0)

typedef struct {
    const char *name;
    void (*fn)(void);
} test_case_t;

#endif
