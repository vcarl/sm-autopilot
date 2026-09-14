# Vision: a pilot that plays

We are building a working SpaceMolt player. It takes a broad objective from its operator, decides how to pursue it the way a human player would, and makes progress for days with almost nobody watching. It levels up, earns credits, keeps itself alive, and leaves behind an account of what it did that the operator can trust. It is also interesting to watch: a player that stagnates, repeating the same safe trip forever, has failed even if nothing went wrong.

This document says what we intend and why. It is the reference for "are we building the right thing." It is not a task list, a specification, or a contract; those live in `TODO.md` and in code. When a proposed change is hard to judge, read this first and ask whether the change makes the pilot more like the one described here.

## The player at the station

The central image is a human player docked at a station. At the station they look around, think about what they want, and choose: where to go, what to gather or build or carry, which contract to take, whether to fit a different laser, whether tonight is a cautious night or an ambitious one, whether this station is worth calling home. Then they undock, and for a while the game plays itself: the ship flies the route, mines the belt, fights off what attacks it, and comes back. Then they are at a station again, and they choose again.

Our agent is that player at the station. Our scripts are everything that happens between stations.

The line between them is the station principle: **the agent decides everything a human player would decide while docked; scripts decide everything a human player would do while flying.** Objective, stance, mood, home, which job comes next, which site, which recipe, which contract, which fit: the agent's. Routes, timing, retreat, servicing, defense, custody of cargo and passengers, cleanup: the script's. A script may refuse a job it cannot do safely and may suspend one that turns dangerous. It never redirects the pilot to a different goal.

The station is not only where the agent thinks; it is where the agent acts with its own hands. A docked player reads the market and buys what it needs, browses recipes and works out which are worth making, takes a contract off the board, moves things between the hold and storage, refits, talks to other players, reads the news. None of that is a trip out and back, so none of it is a job. But a purchase, a craft, or an accepted contract still spends or commits, so the same guarantees sit underneath the counters: permissions are checked before money moves, accounting keeps what was quoted apart from what cleared, and a lost response is reconciled from the game's state before anything is retried. Every station offers the same counters, so every stance carries the same station tools. What differs by stance is which counters the guidance points at, and the menu says which are worth visiting right now. The skills' first duty is to teach how these counters work: how the market forms a price, what a recipe costs against what it sells for, what a contract really promises.

## Rest and reflection

Rest is an intentional act, and it happens only at home.

A pilot that is safe and serviced at home puts the evening down. Resting clears the stance. Then the agent reflects on its needs: what skills are lagging, what the ship lacks, what it owns and owes, what it has seen of the world, and what it has been doing lately. From that reflection it picks a high-level goal that advances it through the game, and from the goal a stance and an initial mood. That choice opens a shift, the period from one rest to the next, and it is the only place a stance is chosen.

Reflection exists to fight stagnation. A goal that repeats last week's shift because it was safe is a poor reflection. The pilot should notice when it has been doing the same thing for too long and reach for something that changes its position: a new skill, a better ship, a farther system, a kind of work it has not tried. Progress and variety are what make the pilot worth watching.

Reflection is subordinate to the objective. When the operator's objective is open-ended or absent, reflection chooses freely. When it is bounded, reflection chooses how to advance it and nothing else, and a bounded objective that is complete means the pilot rests and stays rested. Scheduled wakeups find it idle, it reports that it is done, and it waits for the operator to give it something new. Variety fights stagnation within the operator's intent, never over it.

Rest is not the same as coming home. The pilot can dock, refuel, repair, and unload at any station, including home, and undock again in the same stance. Only rest ends the stance, and only at home.

## Tired

Tired is a mood, built into the mood system like the others, with one difference: the agent may not pick it. The world imposes it.

Every mood carries margins. When the pilot's fuel, hull, ammunition, or credits cross the current mood's margins, the mood becomes Tired, whatever the agent wanted. A Tired pilot starts nothing new. It resolves immediate danger, preserves what it is carrying and what it owes, returns, resupplies, and records what was left unfinished. Resupplying clears Tired and restores the mood that was there before; the stance is untouched throughout. Nobody has to un-Tire the pilot. Growing Tired and resupplying is a pit stop in the evening, not the end of it; ending the evening is rest, and rest is the agent's choice.

The operator can force Tired at any moment, from outside, and that overrides everything including a job in progress. That is the emergency stop, and it is the operator's to release. Nothing else latches. The agent does not stop itself by declaring Tired; it chooses a calmer mood, or a different objective, or waits.

Resupply is not always possible. Credits can be too low for fuel, ammunition can be unavailable, home can be unreachable. A Tired pilot in that position is not stuck; it has a shortlist of permitted recoveries, all inside the operator's standing permissions: sell what it carries to afford the way home, take a cheaper service at a nearer station, dock somewhere that is not home and hold there, ask for help from local players or friends.

## The menu

The agent should choose from options, not guess and be refused.

Given stance, mood, and place, plus what the pilot has, what it owes, and what the operator allows, a rules engine works out what is admissible and worthwhile right now: which counters are worth visiting, which jobs, which sites, which targets, which contracts, and within what bounds. That is the menu the agent sees at every juncture, with the reasons attached. The same rules drive every script, so the menu and the execution agree by construction.

The menu is never empty. A pilot idle at a base with no stance, no mood, and nothing owed still has meaningful things it could do, and the menu says what they are.

The menu bounds; it does not command. The agent weighs the options against its goal, its read of the world, and what it has been doing lately, and it may also act outside the menu: attempt something the tools allow that the engine did not suggest, decline everything and move, or rest. Scripts still refuse what they cannot do safely. The distinction that matters is this: an option the agent picked from the menu is accepted under the conditions the menu was built from. The world can move between observation and action, and when it has, the refusal names the changed condition and comes with a fresh menu. A refusal under unchanged conditions means the menu was wrong, and fixing the menu is the fix. An off-menu attempt that a script refuses is the script doing its job, and the refusal should say what would have made it admissible.

The rules engine and the pilot's durable journal are how the pilot stays safe and remembers what it was doing across crashes and reconnects. They are the pilot's own machinery. The agent sees their conclusions, never their internals.

## Junctures

The agent is consulted at junctures, and waits in between.

A juncture is a moment a human player would be back at the station deciding: a job or a chain of jobs finished, or was blocked, or the pilot came home Tired, or the world changed in a way the goal did not anticipate. If the pilot has been idle too long without a juncture arriving, the runner brings one on a schedule so the agent looks around and picks something. The schedule fires only while the pilot is idle; while a job runs, the runner itself raises the juncture when the job ends.

The agent decides how much work sits between junctures. Jobs are simple on their own, and the agent may compose them at a juncture into a chain: a sequence, a loop until a condition, or one job and then ask again. A goal that takes thirty trips can cost three junctures or thirty, at the agent's discretion, and a well-run shift costs few.

Between junctures the runner keeps the pilot safe and the agent idle. A job can take many minutes, because the world moves on its own clock; that is the game working, not a stall.

## What the agent sees

Every time the agent is consulted it sees the present: where the pilot is, what it has, what it owes, what just happened, and the menu. It does not see the pilot's history rendered again and again. The account of past work lives in the journal, and the agent can ask for a piece of it when a decision needs it. A long shift should leave the agent's context small.

The tools and guidance in front of the agent match its stance. A hunting pilot has hunting tools and the hunting skill. A Tired pilot has the same tools it had a minute ago; what changes is the menu, which offers only the way home. Choosing a stance at rest begins a shift with a fixed toolset and the guidance that fits, carrying the goal and the last outcome forward. The shift lasts until the next rest. Within it, nothing moves under the agent: mood may change, Tired may come and go, but the tools stay the same, and the pilot can always look, travel, dock, and service the ship with what it has. A shift is not one conversation. Every juncture may open a fresh conversation with the model, and the journal, not the conversation, is what carries the shift across them.

Skills teach choices, not procedures. The shared skill teaches what the pilot's world is, how to read its state, how to choose home and mood, and how to interpret outcomes. A stance skill teaches how to choose well within that kind of work: what to look for, what a good job looks like, when to reconsider. Those two are loaded into every conversation of the shift and stay for its life. Beyond them, skills are surfaced on demand: what this kind of place offers, how a particular counter works, what a contract of this type promises. The rules engine names which of those apply right now, from the same stance, mood, and place it used to build the menu, and the agent reads them when it needs them.

A skill describes a script by its promise and its outcome, never its branches. Scripts vary inside themselves with the world: a different route under a cautious mood, an earlier return from a contested belt, a shorter run when the hold is nearly full. The agent is never coached about that variation and never asked to account for it. Sequencing and safety are the scripts' job, and a skill that has to explain a state machine is covering for a script that should not need one.

## The operator

The operator supplies objectives and standing permissions: how much may be spent, what may be attacked, where not to go. These are set once and rarely change. The operator also steers occasionally in conversation, adjusting the objective or answering a question the agent raised, and can stop the pilot from outside at any time.

Minimal supervision means the operator is never needed for the pilot to keep going, and is never surprised by what it did. What the pilot reports must be true: claims about progress, cost, and position come from the game's state and the journal, not from the agent's prose.

## The runner and its clients

One runner owns one pilot. It holds the connection to the game, the journal, the rules engine, the conversations it opens for junctures, and the schedule. It is the thing that keeps the pilot safe and decides when the agent is needed.

Everything else is a client of the runner. A chat channel is a window for giving objectives and reading outcomes. A scheduled job is a way of asking the runner to bring a juncture. A command line is a way to run the same runner by hand. None of them own the pilot, and the pilot behaves the same whichever window is open.

## The layers

The system has four layers, and each one has a job the others must not take over.

**Decision-making** is the language model. It reads the present, weighs the menu against its goal, chooses, and at rest reflects. It navigates the world as a player does: by judgment, not by procedure.

**Rules** are one table with several consumers. Given the current world context, stance, mood, place, holdings, obligations, permissions, the same rules decide what goes on the menu, which skills are surfaced, and how a running script behaves. Interlocking means they agree because they are the same rules, not because three systems were kept in step by hand.

**Skills** describe how to use what is available. Some are preloaded for the shift; the rest are surfaced on demand, limited by the rules to what fits right now. They teach choices and counters, never internals.

**Scripts** are mechanical execution. They carry the pilot between docks, keep it safe, vary internally with the world by consulting the rules, and return an outcome. The agent sees the promise and the result, never the machinery.

## Vocabulary

These words are load-bearing. Each names one rung or one moment, and none is a synonym for another.

| Word | Meaning | Who sets it |
|---|---|---|
| **Objective** | What the operator wants the pilot to accomplish. Bounded or open-ended. Outlives every shift. | operator |
| **Goal** | What this shift will do to advance the objective. Chosen at rest. | agent |
| **Job** | One bounded trip, dock to dock, chosen from the menu. | agent |
| **Chain** | Jobs composed at a juncture: a sequence, a loop until a condition, or one job then ask. | agent |
| **Step** | A mechanical unit inside a job. Never model-visible. | script |
| **Command** | One game API call. | script |
| **Shift** | Rest to rest. The period a stance is held. | agent, by resting |
| **Juncture** | A moment the pilot consults itself about work. | runner |
| **Rest** | The juncture at home that ends a shift and, through reflection, starts the next. | agent |
| **Wakeup** | The scheduled juncture that fires only while the pilot is idle. | runner |
| **Conversation** | One model context with a fixed prompt and toolset. A shift spans many. | runner |
| **Turn** | One model invocation inside a conversation. | runner |
| **Human turn** | An inquiry or direction in a channel conversation. Not a juncture. | operator |
| **Menu** | The options at a juncture. | rules |
| **Outcome** | What a job reports to the agent. The short form of a receipt. | script |
| **Receipt** | What a job writes to the journal. | script |

Words we do not use for our own work: **plan**, which is only goal plus stance plus mood; **task**, which invites deciding between steps; **mission** and **contract**, which name items on a station board and nothing else; **session**, which belongs to Hermes internals and is a conversation here.

## How we judge a change

- Does it make the agent more like a player at a station, deciding, and less like an operator of a machine, being refused?
- Does it keep the agent's world the present, plus a menu, plus a short account of what just happened?
- Does it keep safety, custody, and truth inside the scripts and the journal, where the agent cannot forget them?
- Does it let Tired arrive from the world and leave with resupply, with nobody having to remember to clear it?
- Does the pilot behave the same from every window?
- Would a human player recognize the stance as a way to spend an evening, the job as a trip out and back, and the choice as one they would make while docked?
- Does it help the pilot notice stagnation and reach for something new at its next rest, rather than settling into the safest loop?

A change that fails one of these is probably solving the wrong problem, however well it is built.

## What we are not building

We are not building a chat interface to raw game commands, a tool per game verb, or a state machine the agent has to learn to operate. We are not building a proof system whose output the agent must read. We are not building a set of tuning knobs the agent passes on every call. We are not building anything that requires the operator to sit with the pilot.

We are building a player.
