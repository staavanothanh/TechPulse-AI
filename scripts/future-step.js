const task = process.argv[2] ?? 'future-step'
console.error(`${task} is reserved for a later blueprint step; no implementation exists in Step 1`)
process.exitCode = 2
