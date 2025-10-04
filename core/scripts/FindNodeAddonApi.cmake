# Find the N-API library
# --------------------------
# NodeAddonApi_FOUND        - True if N-API was found.
# NodeAddonApi_INCLUDE_DIRS - Location of N-API.h

unset(NodeAddonApi_FOUND)
unset(NodeAddonApi_INCLUDE_DIRS)

execute_process(
  COMMAND node -e "console.log(require('node-addon-api').include_dir)"
  WORKING_DIRECTORY ${PROJECT_HOME}
  OUTPUT_VARIABLE NodeAddonApi_INCLUDE_DIRS
)

if(NodeAddonApi_INCLUDE_DIRS)
  set(NodeAddonApi_FOUND 1)
endif(NodeAddonApi_INCLUDE_DIRS)
