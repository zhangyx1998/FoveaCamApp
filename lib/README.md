# Shared libraries

Code under `/lib` are shared between the Node.js `core` addon and the micro controller firmware.

The `core` module references these files directly, while `firmware` is managed by platformio, which makes a copy of the files under this directory. Therefore, any changes made to files under this folder requires `make clean` under the `firmware` folder to ensure their reference is up-to-date.
