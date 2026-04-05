# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KenKen Solver — a web app that lets users photograph, manually enter, edit, and solve KenKen puzzles. Uses Claude's vision API to OCR puzzle images from photos.

## Commands

- **Start server:** `npm start` (runs `node server.js`, serves on http://localhost:3000)
- **No test or lint setup** — there are no test scripts or linters configured.

## Architecture

**Single-page app with an Express backend.** Two source files:

- `server.js` — Express server with one API endpoint:
  - `POST /api/analyze` — accepts a base64 image, sends it to Claude Sonnet vision API with a detailed OCR prompt, validates the returned puzzle text (up to 3 attempts with diagnostic feedback), returns parsed puzzle data.
  - Uses `validatePuzzle()` to check cell coverage, cage constraints, and bounds. On validation failure, sends diagnostics back to Claude for self-correction.

- `kenken-zero.html` — entire frontend in a single file (HTML + CSS + JS, ~1850 lines). Three UI modules controlled by `showModule()`:
  1. **Load Puzzle** (module 1) — camera/photo upload, blank grid, or example puzzles
  2. **Puzzle Editor** (module 2) — interactive grid editor for defining/editing cages with tap-to-select, cage operations, and validation
  3. **Solve** (module 3) — runs the solver and displays the solution grid

  The client-side solver (`class KenKenSolver`) uses constraint propagation with backtracking, bitmask domains (`Uint16Array`), and precomputed cage assignments. Solves entirely in-browser.

## Key Details

- `.env` holds `ANTHROPIC_API_KEY` (already in `.gitignore`)
- The vision API call uses `claude-sonnet-4-6` model
- Puzzle text format: first line is grid size, subsequent lines are `TARGET+OP CELLS` (e.g., `12* 1,1 1,2`)
- Grid coordinates are 1-indexed (row,col), top-left = 1,1
