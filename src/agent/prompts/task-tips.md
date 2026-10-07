<!--
Task-specific tips, NOT part of the main agent prompt. A section is sent to the agent only when:
  - the decision model (Jev, via the backend's dispatcher role) picks it from the descriptions below
    for the current situation (labelled as automatically added, possibly not useful), or
  - the agent asks for it with the get_tips tool (by topic id).
Format: "## <topic-id> | <one-line description>" followed by the tip text.
The description is what the decision model reads, and it is shown to the agent in a list of available tips.
Keep each tip short; it is added to every step while it applies.
-->

## shopping | buying things online: cart quantity problems, minimum orders, cart tab mismatch
Some products can't be bought in single units: the quantity control snaps back or refuses to go lower, or the page says "minimum order quantity", "min. qty" or "sold in packs of N". If lowering the quantity fails once, do NOT delete the item and re-add it — it comes back with the same minimum. Note the minimum in your notepad and decide once: keep it if it fits the task, or drop that product and pick another (note why, so you never add it again). Before adding any product, check your notepad for products you already ruled out. If there is a mismatch between added items on different tabs, reload the tabs to reflect the latest changes.

## board-game | playing a board game in the browser (chess, checkers, etc.): selecting and moving pieces
Clicking a selected piece again DESELECTS it. Before clicking a piece, check the latest screenshot for a selection highlight (highlighted square, outline, or dots marking legal moves). If the piece you want to move is already selected, do NOT click it again — click the destination square directly. Only click a piece when nothing (or a different piece) is selected. After each click, verify with a new screenshot whether the piece is selected before deciding the next action.
Pieces and move dots are often listed with the square they sit on (e.g. `@e7`, `@c6`): pick the destination by that square name, not by where a label looks to be. Don't assume you are white / player 1 / the side that moves first: you may be playing either side. Work out which side is yours from the page (the task, a "you play black"-style note, whose clock or turn indicator is active, which pieces you're allowed to move) and only move your own pieces. Boards usually show your side at the bottom, so the board isn't "flipped", it's just from your point of view; read square names from the rank/file coordinates on the board edges, never assume a1 is bottom-left.
After every move, read the move list to confirm it was played as intended (right piece, right square) BEFORE planning the next one, and update your notepad with the actual position. If the move list disagrees with what you meant to play, trust the move list. If the opponent needs time to reply after your move (the board still shows your move, or it's not your turn yet), call change_step_delay with a few seconds so the next screenshot is taken after their move; lower it again if the replies are instant.
You can use all the peices at your disposal. You need not necessarily get hung up on one peice.
