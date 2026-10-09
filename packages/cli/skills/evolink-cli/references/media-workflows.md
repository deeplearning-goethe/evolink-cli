# Media workflows

Use these notes when the user requests an image edit, a reference-based video, speech or music. Follow the shared quote, approval, recovery and delivery workflow in SKILL.md for every task.

## Image creation and editing

- For a new image, discover image models and read the chosen model's parameters, supported dimensions and output count.
- For an edit, confirm that the source image is available as a readable local file or a public URL. Upload local files once, then pass the returned URL through the model's documented image-reference field.
- Describe the requested change and what should be preserved. Choose a model supporting those reference inputs; do not convert an edit into an unrelated text-to-image request.

## Video with reference media

- Identify whether the user needs text-to-video, an image as a first frame, multiple reference images or an existing video as input. Read the model's documented roles and limits before uploading or quoting.
- Keep duration, resolution, aspect ratio and sound explicit when supported. An input reference video's duration may affect billing independently of the requested output duration. Report partial estimates as partial totals.
- `--media-seconds` helps estimation only. It never establishes the model's duration parameter or a settlement ceiling.

## Speech and music

- For speech, distinguish text-to-speech from an edit of supplied audio. Choose only documented voice and language options. A voice name does not establish support for cloning or a reference voice.
- For music, establish instrumental versus vocals and the intended style. Only send lyrics, title, duration or other controls when the selected model supports them.
- Some audio models bill by input length or an output duration that is unknown in advance. Show the rates and that uncertainty before requesting approval; do not invent a total.

## Several outputs

Keep each quote bound to its exact inputs and budget. Approval must cover the concrete quoted outputs. Record each quote and task ID separately so a lost reply can be recovered without submitting duplicate tasks. If a task is already running, waiting or downloading its results does not authorize another generation.
