#include "Error.h"

#include <string>

namespace Arv {

thread_local GError *Error::error = nullptr;

void Error::check(const char action[]) {
  if (error != nullptr) {
    auto err = Error(std::string(action) + ": " + std::string(error->message));
    g_clear_error(&error);
    throw err;
  }
}

} // namespace Arv
