# Dream

**A memory system for agents. The model is the engine; Dream is everything that remembers.**

Version 0.1. Status: partially built and measured. See Status, below, for what exists today.

---

## 1. What Dream is

Dream sits between an application and any language model. It holds everything the agent has ever seen, keeps recent material at full detail, compresses older material progressively, and feeds each model call the smallest set of tokens that call actually needs.

The name comes from the part that does the work. Compression, reconciliation, and promotion happen after a task ends, while nothing is waiting on a response. Biological memory consolidates during sleep for the same reason: it is cheaper to reorganize when nothing is being asked of you.

Dream is model-agnostic by construction. Everything it stores is plain text and structured records on disk, so the same memory works with Claude today and a different provider tomorrow.

## 2. Why it exists

Three facts about language models, and the architecture follows from them.

**A model call is a pure function.** Tokens in, tokens out, and no state survives the call. Any memory an agent appears to have was built by the system around it.

**Attention degrades with length.** Past a modest size, adding tokens makes each token reason worse, not just cost more. Recall of a specific fact buried in a long context is unreliable in every frontier model and gets worse as the context grows.

**Storage outside the model is free, lossless, and effectively infinite.** A file does not forget and does not hallucinate.

Therefore: durable state belongs on disk, and the context window is a cache over that state rather than the state itself. Every component below is a consequence of that sentence.

## 3. System map

```
   application (any SDK, unchanged)
        │
        ▼
   ┌─────────────────────────────────────────────┐
   │  GATEWAY            drop-in proxy            │
   │  intercepts /v1/messages, assembles window   │
   └───────┬──────────────────────────┬──────────┘
           │ assembles                │ forwards
           ▼                          ▼
   ┌───────────────┐            model provider
   │    WINDOW     │            (Claude, GPT, local)
   │ raw tail      │
   │ + tier 1      │◄──── RECALL ────┐
   │ + tier 2      │                 │
   │ + graph index │                 │
   └───────────────┘                 │
                                     │
   ┌─────────────────────────────────┴──────────┐
   │  after the turn completes, off the path    │
   │                                            │
   │   PRESS ──► STORE ──► DREAM ──► GRAPH      │
   │   compress  archive   consolidate  structure│
   └────────────────────────────────────────────┘
                        │
                        ▼
                    EVAL  (measures what was lost)
```

## 4. Components

### 4.1 Gateway

A proxy speaking the Anthropic Messages API. The application changes one line:

```js
const client = new Anthropic({ baseURL: "http://localhost:8082" });
```

Request shape, response shape, and SDK stay the same. The gateway intercepts `POST /v1/messages`, replaces the `messages` array with an assembled window, forwards upstream, and returns the response untouched apart from added `x-dream-*` headers reporting what it did.

Nothing else in the request is modified. Model, system prompt, tools, sampling parameters all pass through.

**Also exposed:**
- `GET /blocks/:id` returns the original text of any compressed block.
- `POST /recall` runs a query against the graph and returns matching nodes.
- `GET /stats` reports store size, tier distribution, and cache hit rate.

### 4.2 Press

Compression. Two backends.

**Semantic press** sends a block to a cheap model with instructions to rewrite it as telegraphic notes preserving every fact, name, number, decision, preference, and outcome, and to collapse repeated log lines to one example plus a count.

**Mechanical press** runs without a model. It normalizes volatile parts of each line (timestamps, hex identifiers, durations), fingerprints the result, and keeps at most two lines per fingerprint. This collapses repetitive machine output very effectively and costs nothing.

**Salience extraction** handles recursion. Mechanical dedupe cannot be applied twice, since deduplicated text has nothing left to deduplicate. Salience extraction scores each line (human turns above machine output, lines carrying numbers or decisions above lines carrying stack frames) and keeps the densest fraction. This is what allows tier 2 and beyond without a model.

**Tiers.** Text is pressed repeatedly as it ages. Tier 0 is raw. Each subsequent tier is smaller and covers more history. A fixed token budget spanning several tiers represents a very large amount of past, because coverage grows geometrically while the budget stays flat. Pressing stops automatically when a tier fails to shrink by at least 15%, which is the signal that the material is incompressible.

Measured behavior is in Status, below. The important property is that the depth limit is a measured number, not a guess.

### 4.3 Store

Content-addressed archive. Every block is keyed by the hash of its original text, so a block is pressed once and only once. Conversations are append-only, which means the old portion of a history does not change and cache hit rate approaches 100% in steady state.

The store serves two roles at once. It is the cache that makes compression nearly free after the first pass, and it is the archive that makes compression non-destructive: any pressed block can be expanded back to its original wording through `GET /blocks/:id`.

**Layout:**

```
dream-store/
  blocks/
    t1-<hash>.json     { id, tier, pressed, original, at }
    t2-<hash>.json
  graph/
    nodes.sqlite       facts, entities, decisions, procedures, episodes
    index.txt          one line per node, loaded at boot
  skills/
    <name>.md          promoted procedures
  eval/
    curve-<date>.json  measured retention per tier
```

This directory is the entire memory. It is portable, inspectable, and deletable. Deleting it costs re-pressing and nothing else.

### 4.4 Graph

Structured memory, distinct from compressed text. Compression preserves a transcript in less space. The graph holds what was learned, independent of any transcript.

**Node types:**

```
fact       { subject, predicate, object,
             confidence 0-1, source_episode,
             last_confirmed, decay_class }
entity     { name, type: person|project|tool,
             aliases[], one_liner }
decision   { choice, rationale, alternatives_rejected,
             status: active|superseded }
procedure  { trigger, steps[], success_count,
             fail_count, last_used }
episode    { summary, transcript_ref, outcome, tokens_spent }
```

**Edges:** `about` connects facts to entities. `derived_from` connects any node to its source episode. `supersedes` connects a new node to the one it replaces. `used_in` connects procedures to episodes.

Nothing is deleted. Superseded nodes remain reachable, so the question "why did you change your mind about this" has an answer with provenance attached.

**Index layer.** One line per node, regenerated whenever a node changes. The index is what loads at the start of a session. For thousands of nodes it costs a few hundred tokens. Detail is fetched only when a step needs it.

### 4.5 Dream (consolidation)

The namesake loop. Runs after a task completes, with a deeper pass on a schedule.

1. **Extract.** A cheap model reads the episode and emits candidate facts, decisions, procedures, and contradictions. This is mining rather than summarizing.
2. **Reconcile.** Each candidate is matched against the graph. Novel material is inserted. Material confirming an existing node raises its confidence and updates `last_confirmed`. Contradicting material creates a new node with a `supersedes` edge. Trivia is discarded.
3. **Index.** One-line entries for affected nodes are rewritten.
4. **Decay.** Low-confidence facts that were never reconfirmed age out. Duplicate entities merge. Blocks molt to the next tier based on age.
5. **Promotion.** A procedure with roughly five clean successes is compiled into a skill file. Behavior that repeats graduates from remembered to installed, after which it costs zero recall tokens.

Promotion is what makes the system improve rather than merely accumulate. Each completed task moves some knowledge out of expensive context and into cheap structure.

### 4.6 Recall

Retrieval as an action the agent takes rather than a bulk load at boot.

The window opens with the index. When a step needs detail, the agent calls `recall(query)`, which ranks graph nodes by `relevance x confidence x recency` and returns the top matches. Stale and unverified material sinks without needing to be pruned.

Recall also unpacks compressed blocks. If a tier 2 note mentions something the agent needs verbatim, it fetches the original by id and gets full resolution for that block alone. Zooming in on one region rather than reloading everything.

### 4.7 Eval

Measurement, treated as a first-class component rather than a testing afterthought.

Given a session and a set of ground-truth facts (each with a question and probe strings that must appear in any correct answer), the eval presses the session through every tier, quizzes each tier using only that tier's text, and reports retention per tier. It identifies the usable depth, the cliff where retention collapses, and exactly which facts died at each level.

The output curve is the regression test for the whole system. Any change to press behavior, salience scoring, or tier policy gets validated by re-running it.

## 5. Data flow

### A turn

1. Application sends a request to the gateway.
2. Gateway assembles the window: raw tail, plus pressed tiers pulled from the store, plus the graph index.
3. Gateway forwards upstream and streams the response back.
4. If the model called `recall`, the gateway serves it from the graph or the block store and the model continues.

Nothing is compressed during this path. Latency added by the gateway is the assembly step, which is file reads and string concatenation.

### A night

1. Completed episodes are read from the store.
2. Extract, reconcile, index, decay, promote.
3. Blocks past an age threshold are pressed to the next tier.
4. If the eval is configured to run, the current curve is recorded so drift is visible over time.

## 6. Deployment modes

| Mode | Shape | Trade |
|---|---|---|
| Library | Imported into the application process | No network hop, no separate service, most private |
| Local proxy | One process on the developer machine | Language-agnostic, works with any SDK |
| Team service | Shared container, per-user stores | Shared skills and entities across a team |
| Hosted | Managed service | Easiest adoption, but the operator holds full transcripts |

The store holds the complete text of everything the agent has seen, which is the most sensitive artifact the system produces. Local by default is the correct starting posture. Hosted deployment requires encryption at rest and a retention policy separating raw originals (short retention) from pressed notes and graph nodes (long retention).

## 7. Interfaces

The contracts that keep components replaceable.

```
press(text, tier, opts)        -> { id, pressed, tokens }
store.put(block)              -> id
store.get(id)                 -> block | null
graph.upsert(node)            -> node_id
graph.query(text, k)          -> node[]
recall(query, k)              -> { nodes, blocks }
assembleWindow(state, budget) -> { messages, stats }
evaluate(session, truth)      -> curve
```

Any implementation satisfying these can be swapped in. The press backend, the storage engine, and the model provider are all independently replaceable.

## 8. Status

**Built and measured.** Gateway, mechanical and semantic press, content-addressed store with cache, tiered recursive pressing, salience extraction, and the eval harness with loss-curve reporting.

Measured on a 39,743-token session with 10 ground-truth facts, mechanical backend, offline grading:

| Tier | Tokens | Ratio | Retention |
|---|---|---|---|
| 0 | 39,743 | 1x | 100% (10/10) |
| 1 | 501 | 79x | 90% (9/10) |
| 2 | 216 | 184x | 90% (9/10) |
| 3 | 97 | 410x | 40% (4/10) |

Usable depth is tier 2. The cliff is tier 3, where the fix, the secret store, and every stated preference disappear.

**Designed, not yet built.** The graph and its index layer, the consolidation loop, recall as a tool the model can call, age-based tier molting, and skill promotion.

**Known gaps.** One ground-truth fact (the session outcome) is lost at every tier including tier 1, which indicates a salience scoring bug rather than a compression limit. The semantic backend has not been measured against the same ground truth, so the value of a model over mechanical pressing is currently unquantified.

## 9. Failure modes

**Cache thrash.** Pressing rewrites the beginning of a conversation, and provider-side prompt caching requires a byte-identical prefix. Pressing on every turn invalidates the cached prefix on every turn. Mitigation: press rarely and in large steps, so the prefix stays frozen across many turns.

**Compounding loss.** Each tier compresses the output of the previous one, so errors accumulate. Mitigation: the eval reports the cliff, and the tier policy stays one level shallower than it.

**Silent forgetting.** A fact can vanish without anything appearing wrong, since the model answers fluently from whatever it has. Mitigation: ground-truth facts checked on a schedule, and confidence scores that make weakly held knowledge visible.

**Provider drift.** Notes written by one model read slightly differently to another, so portability carries some loss. Mitigation: measure it with the eval rather than assume it.

**Store growth.** Raw originals accumulate indefinitely. Mitigation: retention policy dropping raw text past a threshold while keeping pressed notes and graph nodes.

## 10. Roadmap

1. Run the eval with a semantic backend and publish both curves side by side.
2. Fix the salience bug that loses outcomes at every tier.
3. Build the graph and index layer over the existing store.
4. Add `recall` as a tool the model can call mid-task.
5. Age-based tier molting in the consolidation pass.
6. Skill promotion after repeated procedure success.
7. Token-granular raw zone (currently a single oversized message can exceed the budget).
8. Streaming passthrough.
9. Cross-provider portability test: write memory with one model, read with another, measure the delta.

---

## Appendix: naming

| Component | Does |
|---|---|
| Gateway | Speaks the API, assembles the window |
| Press | Compresses text into tiers |
| Store | Archives originals, caches pressed blocks |
| Graph | Holds structured knowledge |
| Dream | Consolidates after the fact |
| Recall | Fetches detail on demand |
| Eval | Measures what compression cost |
