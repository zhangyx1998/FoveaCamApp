const fs = require("fs").promises;
const glob = require("glob");

const db = [];

async function processFile(file) {
    try {
        console.error(`[CompileDB] Processing ${file}.`);
        const content = JSON.parse(await fs.readFile(file, "utf8"));
        if (Array.isArray(content)) {
            db.push(...content);
        } else {
            throw new TypeError("Malformed file " + file);
        }
    } catch (e) {
        console.error(`[CompileDB] Failed to process ${file}:`, e);
    }
}

async function main() {
    // Find all compile_commands.json files in subdirectories
    const ignore = ["compile_commands.json", "**/node_modules/**"];
    const stream = glob.stream("**/compile_commands.json", { ignore });
    const tasks = [];
    for await (const file of stream) {
        tasks.push(processFile(file));
    }

    await Promise.all(tasks);

    console.log(JSON.stringify(db, null, 2));
}

main();
