# Plain English writing rules for Taskboard agents

Taskboard gives these rules to every agent and to the controller. The source is the `kiss` skill in the sekai-superhuman-knowledge repository (`skills/documentation/kiss/references/asd-ste100.md`). When you change a rule, change it in both places.

Use ASD-STE100 Simplified Technical English Issue 9 as the source standard. The official standard has writing rules and a controlled dictionary. This reference gives the working rules for technical and instructional text. It does not replace the official dictionary. The rules apply to these kinds of text:

- the Did / Waiting / Next entries in your task's `log.md`
- documents and artifacts in your task's `outbox/`, in Markdown or HTML, for the user or for other agents
- messages that you send to other agents, and prompts for new agents
- the controller's reports to the user about other tasks
- documents and reports
- pull request descriptions
- commit messages
- code comments
- chat answers

Do not change these items:

- code
- identifiers, commands, file paths, and API names
- quotations and log output
- text that the user tells you to keep

If the user or a project instruction sets a different rule for the same text, follow that rule.

Official source: https://www.asd-ste100.org/

This reference also applies three of George Orwell's rules from "Politics and the English Language" (1946):

- Do not use a long word where a short word has the same meaning.
- Remove each word that you can remove without a change in meaning.
- Do not use a foreign phrase, a scientific word, or a jargon word when an everyday English word has the same meaning.

The lists below replace the controlled dictionary for the most frequent cases. They do not replace the official dictionary.

## Words

- Use an approved general word only with its approved meaning and part of speech.
- Keep code identifiers, API names, service names, command names, and other official technical names unchanged.
- Use one technical noun for one item. Do not use a synonym later.
- Define an unfamiliar technical noun at its first use.
- Use a short technical noun when the code or system does not supply an official name.
- Do not make a new noun to summarize a behavior that you can state with a clause.
- Use American English spelling.
- Do not use slang, idioms, rhetorical questions, or figures of speech.
- Use a verb for an action. Do not use a noun made from a verb. Write `validate the payload`, not `perform validation of the payload`.
- Do not put more than three nouns in a row. Use a preposition to show the relation. Write `timeout for the retry of the upload request`, not `upload request retry timeout`. Keep a longer noun group when it is an official technical name.

### Short words

Use the short word when it has the same meaning. Keep the long word when it is part of an identifier, a signal name, or a quotation.

- `use`, not `utilize` or `leverage`
- `help` or `let`, not `facilitate` or `enable`
- `start`, not `initiate` or `commence`
- `end` or `stop`, not `terminate`
- `show`, not `demonstrate`
- `about`, not `approximately`
- `can`, not `has the ability to` or `is able to`

### Words that add no meaning

Remove phrases that add words and no meaning. Keep articles and connecting words.

- `to`, not `in order to`
- `because`, not `due to the fact that`
- `now`, not `at this point in time`
- Do not write `it is important to note that`, `it should be noted that`, or `basically`. Write the statement.

### Foreign phrases and Latin abbreviations

- `for example`, not `e.g.`
- `that is`, not `i.e.`
- `through` or `by`, not `via`, except in an identifier
- Do not use `per se`, `ad hoc`, `vis-a-vis`, `a priori`, or `etc.`. Write the complete list or state that the list is partial.

## Sentences

- Write one instruction in each sentence.
- Write one main idea in each descriptive sentence.
- Keep an instruction to 20 words or fewer when the technical content permits this limit.
- Keep a descriptive sentence to 25 words or fewer when the technical content permits this limit.
- Put the subject before the verb.
- Use the active voice when the actor is known.
- Use the passive voice only when the actor is unknown or not relevant.
- Use the present tense for current behavior.
- Use the past tense for observed incident events.
- Use `will` only for a documented future result. Use `can` for capability and `must` for a requirement.
- Make each pronoun refer to one clear noun. Prefer `this request` or `this function` to `this` alone.
- Keep articles and connecting words. Do not compress sentences into note fragments.
- Use a vertical list when a sentence contains three or more related items.
- Do not join two statements with a dash or a semicolon. Write two sentences.

## Procedures

- Put a warning or a condition before the step that it applies to. Do not put it after the step.
- Write each step as a command. State the expected result after the step when the reader must check it.
- In a rollout or rollback procedure, state the condition that stops the procedure before the first step that can cause that condition.

## Paragraphs and headings

- Put one subject in each paragraph.
- Put the main statement first.
- Use a heading that states the content. Do not use a slogan or an opinion.
- State the mechanism before the effect.
- State a measurement with its unit, time range, and source.
- State uncertainty with `unknown`, `not measured`, `not observed`, or `inferred from`.
- End with the last decision, the open questions, or the next action. Do not end with a paragraph that repeats the text in general terms.

## Terms and examples

- Use identifiers that exist in the inspected source or infrastructure.
- Do not coin a category name from one observed case.
- State the general rule before a concrete example.
- Use one example when it is necessary. Do not use the same example again as proof of the general rule.
- Do not use an incident detail as the name of a general failure mode.

## Phrasing to remove

Language models write these patterns often. Each pattern adds words and no fact. Remove the pattern or replace it with the fact.

- A clause at the end of a sentence that starts with an `-ing` verb and gives no fact. Examples are `..., highlighting the need for` and `..., reflecting a broader shift`.
- A contrast in the form `not just X, but Y` or `this is not about X; it is about Y`. State Y.
- A list of three adjectives when one adjective or a measurement is sufficient.
- `serves as`, `acts as`, `functions as`, or `stands as`. Use `is`.
- A statement of importance without the dependency. Examples are `plays a key role`, `is critical to`, `underscores`, and `pivotal`. State which item depends on the subject and what fails without it.
- A source without a name. Examples are `it is widely known` and `many teams find`. Cite the source or remove the statement.
- Bold text on a term after its first use.

## Editorial language

Remove an adjective or adverb when it does not change a test, decision, or procedure. Replace an opinion with a measured fact or remove it.

Do not use these words without a cited definition or measurement:

- `clean`
- `comprehensive`
- `critical`, except in an official technical name or a severity level
- `cutting-edge`
- `easy`
- `elegant`
- `game-changing`
- `key` as an adjective
- `obvious`
- `powerful`
- `robust`
- `seamless`
- `significant`
- `simple`
- `substantial`
- `very`

## Automated scan

The script `check_wording.py` is in the same folder as this file. `python3 check_wording.py FILE [FILE ...]` prints a warning for each line that contains a word or phrase from these lists. A warning is not an error. Read each warning and change the text, or keep the text when the word is part of an identifier, a quotation, or a cited definition. The scan does not check sentence structure or the controlled dictionary.

## Final review

- Each sentence has one main idea.
- Each verb states an action or state.
- Each action is a verb, not a noun made from a verb.
- Each technical noun has one spelling and one meaning.
- Each noun group has three nouns or fewer, or is an official technical name.
- Each pronoun has a clear referent.
- Each claim is observed, inferred, proposed, or unknown.
- Each opinion is removed or replaced with a measurement.
- Each example occurs only where it explains a general statement.
- Each warning or condition occurs before its step.
- Each list has one item on each line.
- Each warning from `check_wording.py` is fixed or has a reason to stay.
