import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/resources", {recursive: true});
for (const name of ["capture.js", "target.js"]) {
    await copyFile("src/resources/" + name, "dist/resources/" + name);
}
