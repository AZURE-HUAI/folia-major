import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// build/fetchModels.mjs
// Fetches the model weights the desktop build ships, and refuses to hand over a file it cannot
// vouch for.
//
// The weights are NOT in git: 83MB in an object store that every clone pays for forever, to hold a
// file that never changes and is downloadable in seconds. They ARE in the installer - the licence
// is MIT, so redistribution is allowed, and a user with no route to GitHub is the common case here
// rather than the exotic one.
//
// The hash is the point of this script, not the download. "Downloaded successfully" and "usable"
// are different claims, and four separate times in this project a publisher's weights arrived
// intact and still would not load. A truncated or mirror-substituted ONNX does not fail loudly, it
// loads and answers confidently and wrongly - which for a beat grid means every transition lands
// off the beat with nothing in the log to say why.

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = join(HERE, '..', 'models');

const WEIGHTS = [
    {
        name: 'beat_this.onnx',
        // Beat This! (CPJKU, ISMIR 2024). MIT on code and weights; this is the community ONNX
        // export of the authors' own `final0` checkpoint.
        url: 'https://raw.githubusercontent.com/mosynthkey/beat_this_cpp/main/onnx/beat_this.onnx',
        bytes: 83077778,
        sha256: 'c5c1466e08abdb03fdeb50668a06f244b787d564c212490482231a9cfbe9ccbd',
    },
    {
        name: 'htdemucs.onnx',
        // htdemucs (Meta Research, MIT), the single-file four-stem variant, in the community ONNX
        // export. The fp16-WEIGHTS build: half the download, and identical at runtime - it is
        // dequantised on load, so the same memory and the same latency, with a maximum absolute
        // difference against fp32 of about 6e-5. That is four orders of magnitude below anything a
        // stem envelope can express, and 150MB off every installer.
        url: 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx',
        bytes: 165612636,
        sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
    },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const check = async (path, expected) => {
    if (!existsSync(path)) return false;
    const buffer = await readFile(path);
    return buffer.length === expected.bytes && sha256(buffer) === expected.sha256;
};

await mkdir(MODELS, { recursive: true });

for (const weight of WEIGHTS) {
    const path = join(MODELS, weight.name);
    if (await check(path, weight)) {
        console.log(`[models] ${weight.name} already present and verified`);
        continue;
    }

    console.log(`[models] fetching ${weight.name} (${(weight.bytes / 1e6).toFixed(0)}MB)`);
    const response = await fetch(weight.url);
    if (!response.ok) {
        throw new Error(`[models] ${weight.name}: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Written only after it verifies, so an interrupted or substituted download never leaves a
    // half-file behind that the next run would happily package.
    if (buffer.length !== weight.bytes) {
        throw new Error(`[models] ${weight.name}: got ${buffer.length} bytes, expected ${weight.bytes}`);
    }
    const digest = sha256(buffer);
    if (digest !== weight.sha256) {
        throw new Error(`[models] ${weight.name}: sha256 ${digest}, expected ${weight.sha256}`);
    }
    await writeFile(path, buffer);
    console.log(`[models] ${weight.name} verified and written`);
}
