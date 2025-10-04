# Find the N-API library
# --------------------------
# NodeApiHeaders_FOUND        - True if N-API was found.
# NodeApiHeaders_INCLUDE_DIRS - Location of N-API.h

unset(NodeApiHeaders_FOUND)
unset(NodeApiHeaders_INCLUDE_DIRS)

execute_process(
  COMMAND node -e "console.log(require('node-api-headers').include_dir)"
  WORKING_DIRECTORY ${PROJECT_HOME}
  OUTPUT_VARIABLE NodeApiHeaders_INCLUDE_DIRS
)

if(NodeApiHeaders_INCLUDE_DIRS)
  set(NodeApiHeaders_FOUND 1)
endif(NodeApiHeaders_INCLUDE_DIRS)
