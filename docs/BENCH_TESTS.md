# Bench tests

Every test below is **not executed**. The server is covered by its verifiers and a simulated robot; the checks below need a camera, a robot and the Compute Module. Write a result only after a person ran the step.

## What the software already covers (no hardware needed)

- `python tools/hydra_project_tool.py test` runs the verifiers: routes, contract, global stop, take-over, push, the relay of the OTA progress and the frame probe against a stand-in stream.

## Setup

- The server on a Compute Module 5 with one IP camera that serves RTSP, one robot controller and one administrator and one operator account.
- `safety.publishGlobalStop` switched on only in step 4 and a broker that every bridge listens to.

## Steps

| # | Step | Expected result | Result |
|---|------|-----------------|--------|
| 1 | Point the frame probe at the real camera. | It reports frames per second and the age of the last frame; with the camera off it reports the stream as down. | not executed |
| 2 | Cover the lens and unplug the network cable of the camera in turn. | The probe tells a dark image from a missing stream. | not executed |
| 3 | Read the live state of one robot while it moves. | The state shows a position that changes and a time that is current; when the robot stops sending it is marked stale. Live telemetry per robot is not built yet, so record what is missing. | not executed |
| 4 | Turn on `safety.publishGlobalStop` and press the global stop. | The retained stop is seen by every bridge; only an administrator can release it, and the release is audited. | not executed |
| 5 | Start a firmware update of a URTC head and watch two sessions, one operator and one administrator. | Only the administrator receives the progress. | not executed |

## What this bench cannot show

Camera behaviour over a weak Wi-Fi link and the delay of the global stop across the real controllers.
