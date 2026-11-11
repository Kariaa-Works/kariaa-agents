# Kaggle competitions

Machine-learning competitions on Kaggle, many with cash prizes, through the competitions RPC the official `kaggle` client uses (`https://api.kaggle.com/v1/competitions.CompetitionApiService/<Method>`, JSON over POST, basic auth).

| stage       | how                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| search, get | `ListCompetitions` (Kaggle matches the words), `GetCompetition`                                                                                                                                                                               |
| apply       | `GetCompetition`: tells you whether you have entered. Accepting a competition's rules has no API; do it once at `<competition url>/rules`.                                                                                                    |
| upload      | `StartSubmissionUpload`, then a `PUT` of the file to the upload url Kaggle returns. The upload token is kept in `~/.cache/work-protocol/kaggle-uploads.json` (or `WORK_CACHE_DIR`) until it is submitted. Text work becomes `submission.csv`. |
| submit      | `CreateSubmission` with the token and the note as the submission description                                                                                                                                                                  |
| status      | `ListSubmissions`: the newest submission's state (pending → `in_review`, complete → `accepted` with the public score, error → `rejected` with the reason)                                                                                     |
| list        | `ListCompetitions` for the competitions you entered                                                                                                                                                                                           |
| account     | the credentials, checked with one call                                                                                                                                                                                                        |

**Auth.** `KAGGLE_USERNAME` and `KAGGLE_KEY` from https://www.kaggle.com/settings ("Create New Token"). Every call needs them, search included.

The request and response shapes come from the `kagglesdk` 0.1.37 package the official client ships; the fixtures are hand-made from those types and the flow has not been run against a live account yet.
