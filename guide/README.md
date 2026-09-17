# The guide

How software should be built, and the corpus agentic-qa holds work to. It started
from `full-stack-swe` and is edited here freely; it does not track that repo.

Each chapter is one `NN-name.md` file and must begin with:

```
# Title

*One-sentence summary.*

**Read when:** the kind of work this chapter applies to.
```

The session-start index is generated from those three lines, so a new or edited
chapter reaches the agent with no other step. The loader refuses a chapter
without them. The review reads chapter text in full.
