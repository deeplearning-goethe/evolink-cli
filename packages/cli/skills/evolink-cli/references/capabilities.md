# Discovery and delivery extensions

Read only when comparing models, retrieving schemas, searching model references, querying known task batches or downloading several results.

Use `<command> --help --json` for a machine-readable command description, option enums, bounds and defaults. Help is local and needs no login. Discovery extensions and new list filters come from the bundled shared platform module. `capability_unavailable` means the installed CLI lacks the operation or input field; report the required CLI update. Do not silently remove a requested filter.

## Model discovery

```sh
evolink models recommend --type video --references image --query seedance --json
evolink models schema MODEL --json
evolink docs search --query voice_prompt --type audio --json
evolink models search --type video --page 2 --limit 20 --json
```

Recommendations filter currently available documented models by output type, search keywords and documented reference inputs. Explain the returned selection reasons. They do not establish quality, popularity or the newest release. Unit starting rates are not quotes; get the model parameters and estimate the actual task input before paid generation. Never drop a required reference kind to get a recommendation.

Model schemas are bundled official OpenAPI references with a source commit. `input_schema` retains nested schema definitions; additional runtime constraints in `constraints` and `schema_info` also apply. `response_schema` describes generation submission, which can be an asynchronous task receipt; it is not a promise that all final outputs appear in that schema. Unresolved references and unavailable schemas must be reported. Documentation search indexes model titles, IDs and parameter excerpts, not the whole live site or billing documentation.

## Batch recovery and resource results

```sh
evolink tasks batch --ids TASK_A,TASK_B --json
evolink tasks list --model MODEL --page 2 --limit 50 --json
```

`tasks batch` deduplicates up to 50 task IDs and reports `missing`. Missing/foreign/expired IDs must not trigger automatic regeneration. Preserve `outputs` when a task returns a reusable `voice`, `voice_id`, `persona_id` or `result_id`. Verify the next model's actual input parameter before passing that resource onward. Returning an identifier does not establish a separate voice library, character training or resource-management product.

## All-result downloads

```sh
evolink download TASK_ID --all --output-dir /absolute/results --json
evolink download TASK_ID --all --output-dir /absolute/results --resume --json
```

Optional `--template '{task_id}-{index}.{ext}'` supports `{task_id}`, `{index}`, `{kind}` and `{ext}`. Use a filename template, without directories or unknown placeholders. Filenames must be distinct. Individual transfers keep the existing DNS, content and size validation and never overwrite files.

The receipt records paths, sizes and SHA-256 digests in protected local CLI state. It contains no account credentials. Restore with the same task, service, directory and template. Saved files are checked again; modified files are reported and preserved. `ok: false`, nonzero exit and `delivery_status: partial` mean delivery is incomplete even if `generation_status: completed`. Report successful files and per-result failures; recover the remaining downloads without a paid submission. Downloads transfer originals and do not authorize post-processing.
