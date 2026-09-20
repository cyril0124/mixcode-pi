# mpi-length-resume

[中文](README.zh.md)

Automatically continues answers stopped by the output length limit when native automatic compaction finishes without a retry, or when the settled run remains near the context ceiling. Continuation uses a hidden custom message; Pi owns compaction. Repeated short answers near the ceiling switch to a final-answer prompt, then stop continuing.

The extension reads `compaction.reserveTokens` and `compaction.modelOverrides["provider/modelId"].reserveTokens` from global `<agentDir>/settings.json` and project `<cwd>/.pi/settings.json`. Project values override global values within each setting; the merged model override takes precedence over the ordinary budget. A model override of zero is valid. Missing settings fall back to Pi's default reserve. A reserve covering the entire model window is fitted to 10% of that window.

`ctx.model.contextWindow` supplies the live window. The extension cannot read a host's in-memory SettingsManager overrides; its configured reserve comes from disk. No commands or separate configuration file are registered.
