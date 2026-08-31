/* Minimal specimen module for measuring WebAssembly compile and instantiate
 * cost at JIT-block granularity. One tiny exported function, no memory. */

#include <stdint.h>

__attribute__((export_name("block"))) uint32_t block(uint32_t value) {
    return value * 2654435761u + 7u;
}
