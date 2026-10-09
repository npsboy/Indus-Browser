/**
 * Tool schemas for label targeting mode: elements are picked by the number label
 * drawn on them in the screenshot (one per interactive element).
 */

/** Shared by every action tool: saved to the notepad as part of the action, at no extra step. */
const NOTE_PARAM = {
    type: "string",
    description: "Short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, decided and why, what is done or already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new.",
};

export const LABEL_MODE_TOOLS = [
    {
        type: "function",
        function: {
            name: "click",
            description: "Click an interactive element, identified by the number label drawn on it in the screenshot.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "string", description: "The number label of the element to click, e.g. \"12\"." },
                    click_count: { type: "integer", description: "1 for a single click, 2 for a double click. Defaults to 1." },
                    explanation: { type: "string", description: "one tiny sentence describing what you just clicked." },
                    note: NOTE_PARAM,
                },
                required: ["label"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "type",
            description: "Input text into the currently focused field. Click the field first if it is not focused.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text to input." },
                    press_enter: { type: "boolean", description: "Press Enter after typing, e.g. to submit a search. Defaults to false." },
                    explanation: { type: "string", description: "one tiny sentence describing what you just typed." },
                    note: NOTE_PARAM,
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
                    note: NOTE_PARAM,
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
                    url: { type: "string", description: "The URL to navigate to. Use an existing tab's url to switch to it, or \"back\" to go back." },
                    new_tab: { type: "boolean", description: "Whether to open the URL in a new tab." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are navigating there." },
                    note: NOTE_PARAM,
                },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "scroll",
            description: "Scroll the page, or a scrollable element on it.",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Which way to scroll." },
                    amount: { type: "number", description: "How far to scroll, as a fraction of the screen: 0.5 = half a screen, 1 = a full screen. Defaults to 0.75." },
                    label: { type: "string", description: "Optional. Label of an element inside the scrollable area to scroll (e.g. a sidebar or list). Omit to scroll the main page." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are scrolling there." },
                    note: NOTE_PARAM,
                },
                required: ["direction"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "wait",
            description: "Wait for a number of seconds. Use this when an action is still in progress and you don't want to interrupt it.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "integer", description: "The number of seconds to wait." },
                    explanation: { type: "string", description: "one tiny sentence describing why you need to wait." },
                    note: NOTE_PARAM,
                },
                required: ["seconds"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "warn",
            description: "Warn the user when the very next step is a sensitive action such as login, payment or posting in public. Warn only at the last possible moment, and only if you absolutely cannot proceed even one step further.",
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
            description: "Save something to your notepad (short-term memory). You forget a page's content once you leave it, so note anything you'll need later: information found, options you're comparing (price, rating) and your current best pick, constraints like minimum quantities, and which steps are done. Your notes are shown back to you in every later step.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text to save. With mode \"edit\": the new text that replaces `find` (an empty string deletes it)." },
                    mode: { type: "string", enum: ["append", "replace", "edit"], description: "\"append\" adds to the end of your notes (default). \"edit\" replaces the exact text in `find` with `text`; use it to update a fact, tick off a plan step or delete an outdated line without rewriting everything. \"replace\" overwrites all your notes, e.g. to tidy up." },
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
            name: "read_page",
            description: "Extract the full text of the current page, including off-screen parts. Use it instead of scrolling screen by screen when the task needs you to read a long page (article, documentation, long list or thread). The text is shown in the next step only, so note anything you need. By default you get the main content only (menus, sidebars and footer left out), up to the first 5000 words, which is enough for nearly every page.",
            parameters: {
                type: "object",
                properties: {
                    max_words: { type: "integer", description: "Optional. How many words of the page to return. Leave it out for the default (up to 5000 words); set it only when an earlier read_page said the page was cut short and you need more." },
                    whole_page: { type: "boolean", description: "Optional. Read everything, including menus, sidebars and the footer, instead of just the main content. Leave it out unless the main content lacked what you need (e.g. contact details in the footer)." },
                    explanation: { type: "string", description: "one tiny sentence describing why you are reading the page." },
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_tips",
            description: "Ask for task-specific tips when you are stuck or looping (e.g. topic \"shopping\" when a cart quantity won't go down). The tips are then shown in every later step. Unknown topics return the list of available ones.",
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
            name: "get_context",
            description: "Ask for context that was left out of your step because it didn't look needed (listed at the end of your message under \"Left out\"). It is then included in every later step.",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", enum: ["conversation", "open_tabs", "scroll_position", "step_delay", "older_actions"], description: "The id of the left-out context you need." },
                    explanation: { type: "string", description: "one tiny sentence describing why you need it." },
                },
                required: ["item"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "change_step_delay",
            description: "Change the wait before each of your steps for the rest of the task. Raise it when the page needs time to react between actions (e.g. an opponent's move in a board game, slow loading); lower it (0 for none) when no waiting is needed anymore. The screenshot is taken after this wait.",
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
            description: "Conclude with a final answer to the user's original request. Use it once the entire task is reasonably complete.",
            parameters: {
                type: "object",
                properties: {
                    answer: { type: "string", description: "The final answer for the user in plain natural language (Markdown like bullet points is fine): a short summary of what you did and found. Never JSON or any other data format." },
                },
                required: ["answer"]
            }
        }
    }
];
