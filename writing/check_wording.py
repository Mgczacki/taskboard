#!/usr/bin/env python3
"""Print a warning for each line that contains a word or phrase listed in plain-english.md.

Usage: python3 check_wording.py FILE [FILE ...]

A match is a warning, not an error, because the same word can be part of an
identifier, a quotation, or a cited definition. The exit code is 0 when the
files can be read. The scan does not check sentence structure or the ASD-STE100
controlled dictionary.
"""
import re
import sys
from pathlib import Path

WORDING = [
    (r"\b(utilize[sd]?|utilizing|leverag(e|es|ed|ing))\b", "use `use`"),
    (r"\b(facilitate[sd]?|facilitating)\b", "use `help` or `let`"),
    (r"\b(initiate[sd]?|initiating|commence[sd]?|commencing)\b", "use `start`"),
    (r"\b(demonstrate[sd]?|demonstrating)\b", "use `show`"),
    (r"\bapproximately\b", "use `about`"),
    (r"\b(has|have) the ability to\b|\b(is|are) able to\b", "use `can`"),
    (r"\bin order to\b", "use `to`"),
    (r"\bdue to the fact that\b", "use `because`"),
    (r"\bat this point in time\b", "use `now`"),
    (r"\bit is important to note\b|\bit should be noted\b|\bbasically\b", "write the statement"),
    (r"\be\.g\.", "use `for example`"),
    (r"\bi\.e\.", "use `that is`"),
    (r"\bvia\b", "use `through` or `by`"),
    (r"\betc\.", "write the complete list or state that it is partial"),
    (r"\b(per se|ad hoc|vis-[aà]-vis|a priori)\b", "use an everyday English phrase"),
    (r"\bperform(s|ed|ing)? (an? |the )?\w+(tion|ment|ance|ence|sis)\b", "use the verb, not a noun made from a verb"),
    (r"\bnot (just|only|merely) \w+[^.]*,\s*(but|it is|it's)\b", "state the second part only"),
    (r"\b(serves|acts|functions|stands) as\b", "use `is`"),
    (r"\bplays? an? (key|vital|critical|crucial|pivotal) role\b|\bunderscor(e|es|ed|ing)\b|\bpivotal\b", "state which item depends on the subject"),
    (r"\b(it is widely|many (teams|people|experts) (find|believe|say))\b", "cite the source or remove the statement"),
    (r",\s*(highlighting|reflecting|underscoring|showcasing|emphasizing|illustrating)\b", "remove the clause or state the fact"),
    (r"\b(clean|comprehensive|cutting-edge|easy|elegant|game-changing|obvious|powerful|robust|seamless(ly)?|significant(ly)?|simple|simply|substantial(ly)?|very)\b", "cite a definition or measurement, or remove the word"),
    (r"\b(is|are|was|were) critical\b|\bcritically\b|\bkey (factor|insight|benefit|takeaway|point|part|component)s?\b", "cite a definition or measurement, or remove the word"),
    (r"\u2014|\s\u2013\s|\s;\s|[a-z]; [a-z]", "write two sentences"),
]


if len(sys.argv) < 2:
    raise SystemExit("Usage: python3 check_wording.py FILE [FILE ...]")

warnings = []
for name in sys.argv[1:]:
    for number, line in enumerate(Path(name).read_text(errors="replace").splitlines(), start=1):
        for pattern, advice in WORDING:
            match = re.search(pattern, line, re.I)
            if match:
                warnings.append(f"{name}:{number}: `{match.group(0)}`: {advice}")

if warnings:
    print("Wording warnings (see plain-english.md):")
    print("\n".join(warnings))
