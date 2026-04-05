require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'kenken-zero.html'));
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- PROMPT STRATEGY: Original (default) ----
const PROMPT_ORIGINAL = `You are a KenKen puzzle OCR. Output ONLY raw puzzle data. Your response must start with the grid size number.

IMPORTANT: The image may contain partial puzzles or other content near the edges. Ignore anything that is not part of the main, fully-visible NxN KenKen grid.

FORMAT:
Line 1: grid size (single number, e.g. 7)
Lines 2+: one cage per line: TARGET+OP CELLS

- TARGET = target number, OP = one of + - * /
- CELLS = space-separated row,col (1-indexed, top-left = 1,1)
- Single-cell cages (just a given number, no operation symbol): TARGET row,col

HOW TO IDENTIFY CAGES:
- THICK/BOLD lines between two cells = they are in DIFFERENT cages
- THIN/NO lines between two cells = they are in the SAME cage
- A cell surrounded by thick lines on ALL sides is a SINGLE-CELL cage
- The target number and operation appear in the TOP-LEFT corner of the cage
- If a cell's label has NO operation symbol (just a bare number), it is a single-cell given

COMMON MISTAKES TO AVOID:
- Do NOT group a single-cell given into an adjacent cage. If a cell has thick borders on all sides, it is its own cage.
- Subtraction and division cages ALWAYS have exactly 2 cells.
- Every cell in the grid must appear in exactly one cage. Count them: an NxN grid has N*N cells total.

EXAMPLE (4x4 grid = 16 cells, 6 cages):
4
12* 1,1 1,2
3- 1,3 1,4
6* 2,1 2,2 3,1
2/ 2,3 2,4
7+ 3,2 4,1 4,2
72* 3,3 3,4 4,3 4,4

Output NOTHING except the puzzle lines. No thinking. No preamble. Start with the number.`;

// ---- PROMPT STRATEGY A: Structured single-prompt with step-by-step reasoning ----
const PROMPT_A = `You are a KenKen puzzle OCR. Analyze the image step by step, then output the puzzle data.

IMPORTANT: The image may contain partial puzzles or other content near the edges. Ignore anything that is not part of the main, fully-visible NxN KenKen grid.

STEP 1 — GRID SIZE:
Count the rows and columns of the main grid. Write: "Grid: NxN"

STEP 2 — CAGE BOUNDARIES:
Focus ONLY on the lines/borders. Ignore all numbers and text for now.
- THICK/BOLD lines between cells = DIFFERENT cages
- THIN/NO lines between cells = SAME cage
For each cage, list its cells by row,col (1-indexed, top-left = 1,1).
Write each cage as: "Cage A: (1,1) (1,2) (2,1)" etc.
Verify: every cell appears in exactly one cage. An NxN grid has N*N cells total.

STEP 3 — NUMBERS AND OPERATORS:
Now look at the TOP-LEFT corner of each cage for the target number and operation symbol.
- Operations are + - × ÷ (write as + - * /)
- If a cage has only ONE cell and shows just a bare number with no operator, it is a given value (no operation)
- Subtraction and division cages ALWAYS have exactly 2 cells
Write each as: "Cage A: 12*" or "Cage B: 3 (given)"

STEP 4 — VERIFY:
- Count total cells across all cages = N*N?
- Any cell in two cages? Any cell missing?
- All - and / cages have exactly 2 cells?
- All cages are contiguous (cells connect orthogonally)?
Fix any issues you find.

STEP 5 — OUTPUT:
Now output ONLY the final puzzle in this exact format, with no other text after it:

Line 1: grid size (single number)
Lines 2+: one cage per line: TARGET+OP CELLS
- CELLS = space-separated row,col
- Single-cell givens: just TARGET row,col (no operator)

EXAMPLE output for a 4x4:
4
12* 1,1 1,2
3- 1,3 1,4
6* 2,1 2,2 3,1
2/ 2,3 2,4
7+ 3,2 4,1 4,2
72* 3,3 3,4 4,3 4,4`;

// ---- PROMPT STRATEGY B: Multi-turn decomposition (3 separate calls) ----
const PROMPT_B_STEP1 = `You are analyzing a KenKen puzzle image. In this step, focus ONLY on the grid structure.

IMPORTANT: The image may contain partial puzzles or other content near the edges. Ignore everything except the main, fully-visible NxN KenKen grid.

1. What is the grid size? (count rows and columns)
2. Map out every cage by examining ONLY the thick/bold border lines:
   - THICK/BOLD line between two cells = DIFFERENT cages
   - THIN/NO line between two cells = SAME cage

List each cage with its cells using row,col coordinates (1-indexed, top-left = 1,1).
Format:
Grid: NxN
Cage 1: (1,1) (1,2)
Cage 2: (1,3) (1,4) (2,4)
...

After listing, verify every cell from (1,1) to (N,N) appears exactly once. State the total count.

Do NOT read any numbers or operators yet — only borders and cell groupings.`;

const PROMPT_B_STEP2 = `Good. Now look at the image again. For each cage you identified, read the number and operation symbol shown in the top-left corner of that cage.

- Operations: + - × ÷ (write as + - * /)
- If a single-cell cage shows just a bare number with no operation symbol, it is a given
- Subtraction (-) and division (/) cages ALWAYS have exactly 2 cells

List each cage with its label:
Cage 1: 12*
Cage 2: 3-
Cage 3: 7 (given)
...

Double-check each number carefully against the image. Pay special attention to similar-looking digits (1/7, 3/8, 5/6).`;

const PROMPT_B_STEP3 = `Now combine your cage boundaries and labels into the final puzzle format. Before outputting, verify:
- Total cells = N*N
- No cell appears twice or is missing
- All - and / cages have exactly 2 cells
- All cages are contiguous

Output ONLY the puzzle in this exact format (no other text):

Line 1: grid size (single number)
Lines 2+: TARGET+OP CELLS (space-separated row,col)
Single-cell givens: TARGET row,col (no operator)

Example:
4
12* 1,1 1,2
3- 1,3 1,4
2/ 2,3 2,4`;

// ---- PROMPT STRATEGY C: Single call + verification call ----
const PROMPT_C_INITIAL = PROMPT_A;

const PROMPT_C_VERIFY = `Look at the image again carefully and compare it against this proposed puzzle transcription:

PROPOSED:
{puzzle}

Check each cage one at a time against the image:
1. Are the cage boundaries correct? (thick lines = different cages)
2. Is the target number correct? (look carefully at each digit)
3. Is the operator correct?
4. Are all cells accounted for?

If everything matches the image, output the puzzle again exactly as-is.
If you find errors, output the CORRECTED puzzle.

Output ONLY the final puzzle starting with the grid size number. No other text.`;

// Active prompt strategy — set env var to 'A', 'B', or 'C' to benchmark alternatives
const PROMPT_STRATEGY = process.env.PROMPT_STRATEGY || 'original';

// ---- Full diagnostic validator ----
// Returns { valid: true } or { valid: false, diagnostics: "..." }
function validatePuzzle(text) {
    const lines = text.trim().split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    if (lines.length < 2)
        return { valid: false, diagnostics: 'Need at least a size line and one cage.' };

    const sizeMatch = lines[0].match(/^(\d+)(?:\s*[xX\u00d7]\s*(\d+))?$/);
    if (!sizeMatch)
        return { valid: false, diagnostics: `Invalid size "${lines[0]}". Use N or NxN.` };
    const size = parseInt(sizeMatch[1]);
    if (isNaN(size) || size < 2 || size > 9)
        return { valid: false, diagnostics: `Grid size must be 2-9, got ${size}.` };

    const errors = [];
    const cellUsage = new Map(); // "r,c" -> [line numbers]

    for (let i = 1; i < lines.length; i++) {
        const lineNum = i + 1;
        const parts = lines[i].split(/\s+/);
        if (parts.length < 2) { errors.push(`Line ${lineNum}: need target+op and cells`); continue; }

        const m = parts[0].match(/^(\d+)([+\-*\/\u00d7\u00f7xX]?)$/);
        if (!m) { errors.push(`Line ${lineNum}: bad target/op "${parts[0]}"`); continue; }

        let op = m[2] || '';
        if (op === '\u00d7' || op === 'x' || op === 'X') op = '*';
        if (op === '\u00f7') op = '/';

        const cells = [];
        for (let j = 1; j < parts.length; j++) {
            const token = parts[j];
            const cm = token.match(/^(\d+),(\d+)$/);
            if (cm) {
                const r = parseInt(cm[1]), c = parseInt(cm[2]);
                if (r < 1 || r > size || c < 1 || c > size) {
                    errors.push(`Line ${lineNum}: cell ${token} out of bounds for ${size}x${size}`);
                } else {
                    const key = `${r},${c}`;
                    if (!cellUsage.has(key)) cellUsage.set(key, []);
                    cellUsage.get(key).push(lineNum);
                    cells.push([r, c]);
                }
            } else if (/^\d{2}$/.test(token)) {
                const r = parseInt(token[0]), c = parseInt(token[1]);
                if (r < 1 || r > size || c < 1 || c > size) {
                    errors.push(`Line ${lineNum}: cell ${token} out of bounds`);
                } else {
                    const key = `${r},${c}`;
                    if (!cellUsage.has(key)) cellUsage.set(key, []);
                    cellUsage.get(key).push(lineNum);
                    cells.push([r, c]);
                }
            } else {
                errors.push(`Line ${lineNum}: bad cell "${token}"`);
            }
        }

        if (cells.length > 1 && !op)
            errors.push(`Line ${lineNum}: multi-cell cage needs an operation`);
        if ((op === '-' || op === '/') && cells.length !== 2)
            errors.push(`Line ${lineNum}: ${op} cages must have exactly 2 cells`);
    }

    // Check duplicates
    const duplicates = [];
    for (const [key, lineNums] of cellUsage) {
        if (lineNums.length > 1)
            duplicates.push(`Cell ${key} assigned ${lineNums.length} times (on lines ${lineNums.join(' and ')})`);
    }

    // Check missing
    const missing = [];
    for (let r = 1; r <= size; r++)
        for (let c = 1; c <= size; c++)
            if (!cellUsage.has(`${r},${c}`)) missing.push(`(${r},${c})`);

    if (duplicates.length) errors.push(...duplicates);
    if (missing.length) errors.push(`Missing cells not in any cage: ${missing.join(' ')}`);

    if (errors.length === 0) return { valid: true };

    // Build full diagnostic report
    let diag = `${size}x${size} grid — found ${errors.length} issue(s):\n`;
    diag += errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');

    if (duplicates.length && missing.length) {
        diag += `\n\nLIKELY FIX: The duplicated cells probably belong to only one of their cages. `;
        diag += `The missing cells ${missing.join(' ')} should replace the wrong duplicate entries. `;
        diag += `Re-examine cage boundaries around these cells in the image.`;
    }

    return { valid: false, diagnostics: diag };
}

function stripPreamble(text) {
    const lines = text.split('\n');
    const startIdx = lines.findIndex(l => /^\d+(\s*[xX\u00d7]\s*\d+)?$/.test(l.trim()));
    if (startIdx > 0) return lines.slice(startIdx).join('\n');
    return text;
}

const MAX_RETRIES = 2;

// Helper: single-call with retry loop (used by strategies A and C-initial)
async function analyzeWithRetry(client, imageBlock, prompt, maxRetries) {
    const messages = [{
        role: 'user',
        content: [imageBlock, { type: 'text', text: prompt }]
    }];

    let puzzle = null;
    let lastDiag = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            messages
        });

        puzzle = stripPreamble(response.content[0].text.trim());
        const result = validatePuzzle(puzzle);

        if (result.valid) {
            console.log(`  Validated on attempt ${attempt + 1}`);
            return { puzzle, valid: true };
        }

        lastDiag = result.diagnostics;
        console.log(`  Attempt ${attempt + 1} failed:\n${lastDiag}`);

        if (attempt < maxRetries) {
            messages.push({ role: 'assistant', content: response.content[0].text.trim() });
            messages.push({
                role: 'user',
                content: [
                    imageBlock,
                    {
                        type: 'text',
                        text: `Your puzzle output failed validation:\n\n${lastDiag}\n\nPlease carefully re-examine the IMAGE, especially around the problem cells listed above. Check thick vs thin lines to determine correct cage boundaries. Output ONLY the corrected puzzle text, starting with the grid size number.`
                    }
                ]
            });
        }
    }

    return { puzzle, valid: false, warning: lastDiag };
}

// Strategy B: multi-turn decomposition
async function analyzeMultiTurn(client, imageBlock) {
    console.log('  Step 1: cage boundaries...');
    const step1 = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
            role: 'user',
            content: [imageBlock, { type: 'text', text: PROMPT_B_STEP1 }]
        }]
    });
    const boundaries = step1.content[0].text.trim();
    console.log('  Step 1 done.');

    console.log('  Step 2: numbers and operators...');
    const step2 = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP1 }] },
            { role: 'assistant', content: boundaries },
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP2 }] }
        ]
    });
    const labels = step2.content[0].text.trim();
    console.log('  Step 2 done.');

    console.log('  Step 3: final output...');
    const step3 = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP1 }] },
            { role: 'assistant', content: boundaries },
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP2 }] },
            { role: 'assistant', content: labels },
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP3 }] }
        ]
    });

    const puzzle = stripPreamble(step3.content[0].text.trim());
    const result = validatePuzzle(puzzle);
    console.log(`  Step 3 done. Valid: ${result.valid}`);

    if (result.valid) return { puzzle, valid: true };

    // One retry with diagnostics
    console.log(`  Validation failed, retrying with diagnostics:\n${result.diagnostics}`);
    const retry = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP1 }] },
            { role: 'assistant', content: boundaries },
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP2 }] },
            { role: 'assistant', content: labels },
            { role: 'user', content: [imageBlock, { type: 'text', text: PROMPT_B_STEP3 }] },
            { role: 'assistant', content: step3.content[0].text.trim() },
            { role: 'user', content: [imageBlock, {
                type: 'text',
                text: `Validation failed:\n\n${result.diagnostics}\n\nRe-examine the image around the problem cells. Output ONLY the corrected puzzle starting with the grid size number.`
            }] }
        ]
    });

    const retryPuzzle = stripPreamble(retry.content[0].text.trim());
    const retryResult = validatePuzzle(retryPuzzle);
    if (retryResult.valid) return { puzzle: retryPuzzle, valid: true };
    return { puzzle: retryPuzzle, valid: false, warning: retryResult.diagnostics };
}

// Strategy C: initial analysis + verification pass
async function analyzeWithVerify(client, imageBlock) {
    const initial = await analyzeWithRetry(client, imageBlock, PROMPT_C_INITIAL, 1);

    // If first pass is valid, still do a verification pass
    const verifyPrompt = PROMPT_C_VERIFY.replace('{puzzle}', initial.puzzle);
    console.log('  Running verification pass...');
    const verifyResp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
            role: 'user',
            content: [imageBlock, { type: 'text', text: verifyPrompt }]
        }]
    });

    const verifiedPuzzle = stripPreamble(verifyResp.content[0].text.trim());
    const result = validatePuzzle(verifiedPuzzle);
    console.log(`  Verification done. Valid: ${result.valid}`);

    if (result.valid) return { puzzle: verifiedPuzzle, valid: true };
    // Fall back to initial if verification made things worse and initial was valid
    if (initial.valid) return initial;
    return { puzzle: verifiedPuzzle, valid: false, warning: result.diagnostics };
}

app.post('/api/analyze', async (req, res) => {
    try {
        const { image, mediaType } = req.body;
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        const imageBlock = {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image }
        };

        console.log(`Analyzing with strategy ${PROMPT_STRATEGY}...`);
        let result;

        switch (PROMPT_STRATEGY) {
            case 'A':
                result = await analyzeWithRetry(client, imageBlock, PROMPT_A, MAX_RETRIES);
                break;
            case 'B':
                result = await analyzeMultiTurn(client, imageBlock);
                break;
            case 'C':
                result = await analyzeWithVerify(client, imageBlock);
                break;
            case 'original':
            default:
                result = await analyzeWithRetry(client, imageBlock, PROMPT_ORIGINAL, MAX_RETRIES);
                break;
        }

        if (result.valid) {
            return res.json({ puzzle: result.puzzle });
        }

        console.log('All attempts exhausted, returning last attempt');
        res.json({ puzzle: result.puzzle, warning: result.warning });
    } catch (err) {
        console.error('Vision API error:', err.message);
        const status = err.status || 500;
        res.status(status).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`KenKen server running at http://localhost:${PORT}`);
});
