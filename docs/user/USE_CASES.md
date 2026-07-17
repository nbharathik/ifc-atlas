# Practical IFC and BIM workflows

IFC Atlas is useful when a review starts with a question and ends with a
traceable model change. These workflows use shipped tools only.

## Explore and explain a model

1. Load an IFC file and wait for the model tree and AI readiness indicators.
2. Ask: **“Summarize the building by storey, element type, space, and material.”**
3. Follow with: **“Select the three elements with the most unusual metadata and
   explain why.”**

The assistant reads authoritative IFC data, can select or highlight its answer,
and leaves the IFC unchanged.

## Find model content with natural language

Example prompts:

- “Find external walls on Level 1 and isolate them.”
- “Show fire doors with no FireRating property.”
- “Highlight load-bearing elements whose name is empty.”
- “Find spaces on the ground floor and summarize their areas.”
- “Which elements use concrete, and where are they located?”

Inspect the visible tool label before trusting a result: model reads are marked
**Read only**, presentation changes **Viewer action**, and checks **Validation**.

## Validate information completeness

Use the Model Health panel, IDS validation, or ask:

- “Check naming consistency and group the problems by IFC type.”
- “Find elements without a storey assignment.”
- “Report missing common properties for walls, doors, and spaces.”
- “Validate this attached IDS file and isolate every failure.”
- “Produce a quantity summary by storey and material.”

Validation never modifies the file. Results can highlight or isolate affected
elements and IDS failures can be exported as CSV.

## Review and apply a semantic edit

1. Switch chat to **Edit**, keep the scope on **Semantic**, and leave approval
   on **Ask**.
2. Ask: **“Set the Description of wall #361 to ‘External fire-rated wall’.”**
3. Inspect the tool card and before/after summary.
4. Apply or discard the sandboxed proposal.
5. Use the Timeline or `Ctrl+Z` to review or undo the result.

Other examples:

- “Rename unnamed spaces to `Space - <storey> - <index>`.”
- “Set existing `Pset_WallCommon.IsExternal` values for these selected walls.”
- “Standardize the Tag attribute on the selected doors.”
- “Show edit history and summarize changes made by AI versus the user.”

## Use code generation safely

Ask mode exposes `execute_ifc_query_code` for read-only analyses. Edit mode
exposes `execute_ifc_code`; it runs in a subprocess against a copy with a time
limit and file/network restrictions. Any detected changes still require review.

Good requests are bounded and explicit, for example:

- “Generate a read-only script that counts IfcDoor objects by PredefinedType.”
- “Preview a script that normalizes existing wall descriptions; do not create
  or delete entities.”

Generated code should not be used as a substitute for a dedicated semantic
operation when a structured tool already exists.
