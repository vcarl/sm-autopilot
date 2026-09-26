# SpaceMolt: the vision

SpaceMolt is a game about a ship, a pilot, and the stations between them. This project puts an
agent in the pilot's seat and gives it a runner to fly with. The agent is the player: it decides
at the dock, it writes down how a trip should go, and it lets the ship carry that out while it
thinks about something else. The point is not to automate the game. The point is to see what a
player does with a world that keeps moving whether or not it is looking, a budget it can run
out of, and the freedom to write its own tools.

## One player, one runner

A pilot is one game account. A runner is the one process that holds its connection, keeps its
journal, enforces its rules, and remembers what it was doing across a crash or a restart. The
player never touches the game directly; it decides, and the runner does. One runner owns one
pilot, and a second runner for the same pilot is a bug the first one refuses.

The player exists in two settings. In harness, it is consulted at junctures and acts by running
code. Out of harness, it is the observer: the same player in a conversation with the human,
reading the runner, answering questions about the pilot, and carrying what the human said back
into the harness as direction. The observer flies nothing. It is how the human talks to the
player, and how the player hears the human.

## The player plays by writing code

The player's move is a script: one short file of ordinary code that imports the play library
and composes what it finds there. The player writes the file for the move in front of it, runs
it, and reads the report. Composition, loops, conditions, and the arithmetic of a plan belong in
that file, where the player can see them and change them, not in a runner that would have to
learn every shape of plan in advance. A tool per game verb would give the player a vocabulary;
code gives it a grammar.

The library the player writes against is the runner's, and it is built for the player rather
than by it. A player that grows its own library of saved, named scripts over many evenings is
the ideal, and it is out of reach of the local models that are this project's audience and
its strict requirement. So the compromise is deliberate: far stronger models build the
library's jobs and helpers, watch how the local player fares with them, and add or reshape
what its play shows it needs. The local player's job is to compose well from what it is
given; the stronger models' job is oversight, making sure it has what it takes to succeed at
the game.

Because the player writes code, it needs what a programmer needs: the exact signature of every
function it may call, the game's own command reference, worked examples it can copy, and an
honest error when it gets one wrong. Descriptions of what a function is for are not enough. A
check that a script is well formed happens before it runs, and a script that reaches for
something it may not import is refused with the reason.

## Jobs are the safe primitives

A job is a function that does one bounded thing and is named for the state it leaves: the hold
stowed, the recipe committed, the loot aboard and the ship home. Every job asks the rules
before it starts, reads the world before it changes it, skips any step whose end state already
holds, and measures what it did from the game's state rather than from the reply it was given.
Running a job twice is safe. A job that cannot finish says why, in a sentence, and leaves the
ship somewhere it can be found.

Jobs are few and they are the library's to provide. Beside them sit helpers for the small moves a
script needs between jobs, and one function that sends any command the game knows. That
function is the player's reach into everything the jobs do not yet cover. It asks the rules
first, it is journalled like everything else, and it promises nothing more: a script that buys
twice buys twice. When a pattern of raw commands proves itself in the player's scripts, it is a
candidate to become a job. That is how the library grows: from what the player's play shows
it needs, added by the models that oversee it.

## Junctures are cheap and frequent

A juncture is the moment the player is consulted. It happens when a run ends, when the runner
starts, when direction arrives from the observer, and on a slow schedule while the pilot is
idle. It does not happen while a run is in flight; the runner answers a scheduled fire with one
line then. Each juncture is one short turn, and turns are cheap, so a shift is made of many of
them. A run that failed in seconds does not earn one; the schedule carries that.

At a juncture the player sees the present, read from the live ship; direction from the
observer if any is waiting; its standing objective; and how the last run ended, in the run's
own words with the numbers behind them. It sees these because they were delivered, not because
it fetched them, so the first thing it does is decide. It ends the turn one of three ways: run
a script, hold and watch, or rest.

The runner also computes, from its rules and the present, what the stance and mood would admit
right now and why, and what they would refuse. Whether that list is shown to the player is a
choice, not a law. It bounds; it never commands. The rules the list is drawn from run
regardless, between every job, and they are the same rules whether the player saw them or not.

## Shifts, stances, moods, and rest

A shift runs from rest to rest. The player opens it by choosing a goal that advances its
objective, a stance that says what kind of evening it is having, and a mood that sets how much
risk and spend the rules allow. The stance brings its skill into the conversation and stays for
the shift. The mood may move as the evening goes.

Rest and resupply are one act. The pilot rests by docking at a base that meets its needs,
with nothing running, and taking what the base can give: fuel, hull, unloading, whatever the
evening spent. Rest clears the stance, the mood, and the goal together. Nothing else clears
them, and a base that cannot meet the pilot's needs is not where it rests.

Tired is a mood the player may not choose. It is the world saying go and rest. The runner
imposes it when fuel, hull, ammunition, or credits run down past the mood's margin, and a
Tired pilot starts nothing new, carries what it has to a base that can resupply it, and rests
there. When no such base is within reach, the runner offers the ways out it knows: sell what
is carried, take the cheaper service, hold at the nearest dock, ask the human. Tired can also
be imposed from outside as an emergency stop, and only the one who imposed it lifts that one.

Reflection happens at rest. The player is handed a report the runner assembled: which skills
lag, what the ship lacks, what the pilot holds and owes and where, what it has seen, what it
has been doing, where it has been standing still, and how its runs ended. It reads those, then picks the
next goal, stance, and mood. A goal that
restates the last one in different words is a poor reflection; reflection exists to change the
evening. A bounded objective that is complete is recorded as complete, and the pilot stays at
rest until it has something new.

## The human

The human is not in the game. The human talks with the player through its observer, and what
comes of that conversation is the player's to carry in: an objective, stated as an end and
never as a route; standing bounds, the credit reserve the pilot keeps and the liability it may
carry; and, now and then, a sentence of direction, short by design, which the player reads at
its next juncture as outside instruction that outranks its objective for that turn. There are
no per-activity permission flags. Whether the pilot hunts or crafts or hauls is what the
objective and the direction say; whether it can is a fact about the ship the rules read.

## Nothing is silent

Every command the runner sends, every step a job takes, every run's start and end, every rest
and reflection and instruction, is a line in the pilot's journal. The journal is the pilot's
memory across restarts and the human's window into the shift. A run that has said nothing for
a while is spoken for by the runner, which reports the step, the elapsed time, and the last
command, so a long mining loop reads as progress rather than silence. The journal renders as
one human line per event and is delivered to the human as it accumulates.

What the pilot reports is true because it is measured. A script's closing sentence is the
player's claim; the receipt is the delta in the game's state, and the two are written side by
side. Facts the game owns, like which station is home, are read from the game; the runner's
record follows the game, never the other way round.

## Stations and the world

A station offers counters: market, workshop, boards, storage, hangar, services, obligations,
comms, and home registration. Not every station stocks every counter, and the ones it has can
come back empty. The player learns a station by reading it, never by remembering it. Skills
teach what each counter is for and what makes a trip worth taking for a given stance; they
describe a function by its promise and its outcome and leave the mechanism to the signatures.

The world moves on its own clock. A call that takes a minute is the game working, not a stall.
A pilot the world moved without a command, by respawn, capture, or eviction, is noticed on the
next read, classified, and reported as such, and the job that was under way ends honestly.

## Guidance for a small model

The player is a local model by intent, and everything it reads is written for one. Each idea
has exactly one owner among the prompt, the delivered context, the tool descriptions, and the
skills, and is never restated. Instructions say what to do, not what to avoid. Facts arrive
when they are needed rather than being memorised. The bytes a juncture reads are counted and
kept small. When the model acts wrongly, the first question is what it was not told.

## What we are not building

A tool per game verb. A runner that composes plans. An objective that is an itinerary. A
profit rule that outranks what the output is for. A permission flag per activity. A menu that
commands. A report written from prose rather than state. A second decision-maker beside the
player. A library the local player must build for itself before it can play.

## Vocabulary

**Who**

| Word | Meaning |
|---|---|
| Human | The person outside the game, who talks with the player. |
| Player | The agent: the one decision-maker in the game. In harness it is consulted at junctures; out of harness it is the observer. |
| Observer | The player in conversation with the human: reads the runner, carries direction in, flies nothing. |
| Pilot | One game account, the ship and its standing in the world. |
| Runner | The process that owns the pilot's connection, journal, rules, record, and the play library. |

**When**

| Word | Meaning |
|---|---|
| Shift | Rest to rest. |
| Run | One script from its start to the juncture at its end. |
| Juncture | One turn of the player's, with the present and the last run in front of it. |
| Rest | Resupplying at a base that meets the pilot's needs; the act that ends a shift. |
| Reflection | The reading and choosing done at rest. |

**What the player holds**

| Word | Meaning |
|---|---|
| Objective | What the pilot is for, stated as an end. Outlives shifts. |
| Goal | What this shift does to advance the objective. Chosen at rest. |
| Stance | The kind of evening the pilot is having. Chosen at rest, held for the shift. |
| Mood | How much risk and spend the rules allow. May move within a shift. Tired is the mood the world imposes: go and rest. |
| Instruction | One short sentence of direction carried in by the observer, read at the next juncture. |

**What the runner keeps**

| Word | Meaning |
|---|---|
| Script | The one file of code the player writes and runs for the move in front of it. |
| Job | A bounded, idempotent function the library provides, named for the state it leaves. |
| Journal | The pilot's record of everything that happened, one line per event. |
