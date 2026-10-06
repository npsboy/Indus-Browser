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
