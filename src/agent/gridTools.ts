/**
 * Tool schemas for the legacy grid-coordinate targeting mode. The backend's
 * default tools are label-based, so grid mode sends these with each /agent
 * request to override them.
 */
export const GRID_MODE_TOOLS = [
    {
        type: "function",
        function: {
            name: "click",
            description: "Click on a specific element in the UI.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "string", description: "The column no of the element to click." },
                    y: { type: "string", description: "The row no of the element to click." },
                    click_count: { type: "string", description: "The number of times to click. Can be 1 for a single click, 2 for a double click, etc." },
                    explanation: { type: "string", description: "one tiny sentence describing what you just clicked." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["x", "y"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "type",
            description: "Input text into a specific field in the UI.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text to input." },
                    press_enter: { type: "boolean", description: "Press Enter after typing, e.g. to submit a search. Defaults to false." },
                    explanation: { type: "string", description: "one tiny sentence describing what you just typed." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "keypress",
            description: "Simulate a key press.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "The key to press. Use special names for non-character keys, e.g. 'Enter', 'Tab', 'ArrowDown'." },
                    explanation: { type: "string", description: "one tiny sentence describing what you just did with the key press." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["key"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "navigate",
            description: "Navigate to a specific URL.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The URL to navigate to. Use an existing tab's url to navigate to it. return \"back\" if you want to go back." },
                    new_tab: { type: "boolean", description: "Whether to open the URL in a new tab or not." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are navigating there." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "scroll",
            description: "Scroll to a specific part of the page.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "string", description: "The column no to anchor the scrolling to." },
                    y: { type: "string", description: "The row no to anchor the scrolling to." },
                    delta_x: { type: "string", description: "The no of columns to scroll by. Can be positive or negative. Horizontal scrolling is not used much." },
                    delta_y: { type: "string", description: "The no of rows to scroll by. Can be positive or negative." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are scrolling there." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["x", "y", "delta_y"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "wait",
            description: "Wait for a specific ammount of time. Use this if an action is still in progress and you want to avoid interupting it.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "integer", description: "The number of seconds to wait." },
                    explanation: { type: "string", description: "one tiny sentence describing why you need to wait." },
                    note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
                },
                required: ["seconds"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "warn",
            description: "detect if the very next step is a sensitive action like login, payments, posting in public and so on and warn the user. Only warn at the last moment possible and only if you absolutely cannot proceed even a step further.",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "The warning message to show the user." },
                },
                required: ["message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "write_notes",
            description: "Save something to your notepad (short-term memory). You forget what was on a page once you leave it, so note anything you will need later: information you found, options you are comparing (price, rating) and your current best pick, constraints like minimum quantities, and which steps are done. Your notes are shown back to you in every later step.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text to save. With mode \"edit\": the new text that takes the place of `find` (an empty string deletes it)." },
                    mode: { type: "string", enum: ["append", "replace", "edit"], description: "\"append\" adds to the end of your notes (default). \"edit\" overwrites one part: the exact text given in `find` is replaced by `text` — use it to update a fact, tick off a plan step or delete an outdated line without rewriting everything. To tick off a task or mark it completed, always edit its existing line (\"[ ] 2. …\" → \"[x] 2. …\") instead of appending a new note. \"replace\" overwrites all of your notes, e.g. to tidy up." },
                    find: { type: "string", description: "Only for mode \"edit\": the exact text in your notepad to overwrite, copied character for character. Include enough of it to be unique (e.g. a whole line)." },
                    explanation: { type: "string", description: "one tiny sentence describing what you are noting down." },
                },
                required: ["text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_notes",
            description: "Read your full notepad. Only needed when your notes are too long to be shown to you automatically.",
            parameters: {
                type: "object",
                properties: {
                    explanation: { type: "string", description: "one tiny sentence describing why you are reading your notes." },
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_tips",
            description: "Ask for task-specific tips when you are stuck or looping on something (e.g. topic \"shopping\" when a cart quantity won't go down). The tips are then shown to you in every later step. Unknown topics return the list of available ones.",
            parameters: {
                type: "object",
                properties: {
                    topic: { type: "string", description: "The tip topic id, e.g. \"shopping\"." },
                    explanation: { type: "string", description: "one tiny sentence describing why you need the tips." },
                },
                required: ["topic"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "change_step_delay",
            description: "Change the wait before each of your steps for the rest of the task. Raise it when the page needs time to react between your actions (e.g. an opponent's move in a board game, slow loading); lower it (0 for none) when no waiting is needed anymore. The screenshot is taken after this wait.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "Seconds to wait before each step, 0 to 120." },
                    reason: { type: "string", description: "Short reason for the new delay." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are changing the delay." },
                },
                required: ["seconds"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "final_answer",
            description: "Conclude the agent execution with a final answer to the user's original query/ task. Use this when you feel you have completed the entire task to a reasonable level.",
            parameters: {
                type: "object",
                properties: {
                    answer: { type: "string", description: "The final answer for the user, written in plain natural language (Markdown like bullet points is fine): a short summary of what you did and found. Never JSON or any other data format." },
                },
                required: ["answer"]
            }
        }
    }
];
