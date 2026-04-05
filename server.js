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

const VISION_PROMPT = `You are a KenKen puzzle OCR. Output ONLY raw puzzle data. Your response must start with the grid size number.

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

        // First attempt
        const messages = [{
            role: 'user',
            content: [imageBlock, { type: 'text', text: VISION_PROMPT }]
        }];

        let puzzle = null;
        let lastDiag = null;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const response = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 1024,
                messages
            });

            puzzle = stripPreamble(response.content[0].text.trim());
            const result = validatePuzzle(puzzle);

            if (result.valid) {
                console.log(`Puzzle validated on attempt ${attempt + 1}`);
                return res.json({ puzzle });
            }

            lastDiag = result.diagnostics;
            console.log(`Attempt ${attempt + 1} failed:\n${lastDiag}`);

            if (attempt < MAX_RETRIES) {
                messages.push({ role: 'assistant', content: puzzle });
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

        // All retries exhausted
        console.log('All retries exhausted, returning last attempt');
        res.json({
            puzzle,
            warning: lastDiag
        });
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
