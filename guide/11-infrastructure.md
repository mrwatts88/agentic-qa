# Infrastructure

*What the platform was quietly doing for you, and what you own once the cloud account is yours.*

**Read when:** changing Terraform or cloud resources: networks, security groups, IAM, compute, load balancers or managed databases.

## What you own when there is no PaaS

A PaaS hides a lot of infrastructure behind one deploy button: a network, a load balancer, certificates, machines, patching, autoscaling, log shipping, and a permission model. On a raw cloud (AWS, GCP, Azure) every one of those is a resource you create, configure, pay for, and keep current. Nothing is wrong by default, but very little is right by default either.

The shared responsibility model is the frame. The provider secures the hardware, the hypervisor, and the managed service itself. You secure everything you configure on top: who can reach it, who can call its APIs, what is encrypted, what is backed up, and what version it runs. The more managed the service, the smaller your half. A managed container service leaves you less to get wrong than a fleet of VMs, and that is the main argument for it.

- The names differ per cloud, the concepts do not. A VPC on AWS or GCP and a VNet on Azure are the same idea. Security groups and NSGs are the same idea. Learn the concept once and map the vocabulary.
- Default to the most managed option that meets the requirement. Every layer you run yourself is a layer you patch at 3am.

## Accounts, projects, and blast radius

The outermost boundary in a cloud is the account (AWS), project (GCP), or subscription (Azure). It is the strongest isolation you get for free: separate permissions, separate quotas, separate billing, and a mistake in one does not touch another.

- Production gets its own account. Staging and development get their own. A developer with admin in the dev account should need a separate, audited step to touch production.
- Group accounts under an organization (AWS Organizations, GCP folders, Azure management groups) so guardrails, such as denying regions you do not use or blocking the disabling of audit logs, apply everywhere.
- The root or owner login gets hardware MFA and is then not used. People sign in through SSO to roles.
- Turn on the audit log (CloudTrail, Cloud Audit Logs, Activity Log) and budget alerts on day one. Both are cheap, and both are useless if enabled after the incident.
- Tag every resource with at least service, environment, and owner. Untagged resources are how nobody knows who can delete the $900 a month database.

## Regions and availability zones

A region is a geographic location (us-east-1, europe-west2). An availability zone is one or more physically separate data centers inside it, with independent power and networking, connected by fast links. Zone failures happen a few times a year somewhere. Whole region failures are rare but real.

Running across two or three zones in one region is the standard for production and is mostly a checkbox on managed services: multi-AZ database, load balancer in several zones, app instances spread across them. Multi-region is a different order of cost and complexity, because data has to be replicated across long distances and something has to decide where users go. Most teams do not need it, and those who think they do usually need better backups and a tested restore instead.

- Pick the region close to your users and your data residency obligations. Moving later means moving the database.
- Cross-zone traffic is billed. On AWS it is $0.01 per GB in each direction, so a chatty service talking to a cache in another zone pays twice per round trip.

## Networking: VPCs and subnets

A VPC is your private network inside the cloud, defined by an IP range (a CIDR block like `10.20.0.0/16`). It is split into subnets, each in one zone. What makes a subnet public or private is its route table, not its name. A public subnet routes to an internet gateway, so resources with public IPs are reachable from the internet. A private subnet has no inbound route from the internet at all.

The standard layout: load balancers in public subnets, application instances and databases in private subnets, one of each per zone. Private resources that need to call out (package mirrors, third-party APIs, the cloud's own APIs) go through a NAT gateway, which allows outbound connections and nothing inbound.

- Plan CIDR ranges so they do not overlap with other VPCs, the office network, or a partner's. Overlapping ranges cannot be peered or joined by VPN later, and renumbering a live network is a rebuild.
- Size generously. A `/16` per VPC and `/20` or larger per subnet leaves room for Kubernetes, which can consume an IP per pod.
- Databases never go in a public subnet, and the "publicly accessible" flag on a managed database stays off.

**Gets you burned:**
- NAT gateway bills. On AWS a NAT gateway costs about $33 a month per zone before data, plus $0.045 per GB processed. Container image pulls and S3 traffic flowing through it is the classic surprise. S3 and DynamoDB gateway endpoints are free and take that traffic off the NAT.
- Public IPv4 addresses are billed on AWS (about $3.60 a month each, in use or idle) since 2024. A fleet where every instance gets a public IP pays for that, and is also more exposed than it needs to be.

## Firewalls, security groups, and private access

Security groups (AWS), firewall rules (GCP), and network security groups (Azure) are stateful allowlists attached to resources. The useful habit is referencing other groups rather than IP ranges: the database group allows port 5432 from the app group, the app group allows its port from the load balancer group. Rules then follow the resources as they scale and move.

For humans who need to reach something private, the old answer was a bastion host with SSH open to the world. The current answer is the provider's identity-aware access (AWS Systems Manager Session Manager, GCP IAP, Azure Bastion): no open inbound port, access granted by IAM, every session logged.

- `0.0.0.0/0` inbound is correct on a public load balancer on 80 and 443 and almost nowhere else.
- Managed services can often be reached privately through private endpoints (PrivateLink, Private Service Connect, Private Link) instead of over public endpoints. Use them for databases and caches.
- Egress rules matter too. A compromised app that can reach any address on the internet can exfiltrate to any address.

## Load balancers and ingress

A load balancer is the front door. Layer 7 (HTTP) load balancers such as AWS ALB, GCP's HTTP(S) load balancer, and Azure Application Gateway understand requests: they terminate TLS, route by host and path, run health checks, and can attach a WAF. Layer 4 (TCP/UDP) load balancers like AWS NLB pass connections through, which you need for non-HTTP protocols, static IPs, or extreme throughput.

- TLS certificates come from the provider's certificate manager and renew automatically once DNS validation is set up.
- Health checks decide what gets traffic. Point them at your readiness endpoint, not at `/`.
- Idle timeouts exist at every hop. AWS ALB defaults to 60 seconds. Your app's keep-alive timeout should be longer than the load balancer's, or the LB occasionally reuses a connection the app just closed and users see a 502.
- Long-lived connections (WebSockets, SSE) need the idle timeout raised or heartbeats sent.
- Connection draining (deregistration delay) must be at least as long as your longest request, the same rule as the SIGTERM grace period.

## Cloud IAM

Cloud IAM decides which identity can call which API on which resource. The pieces: principals (users, roles, service accounts), policies that grant actions on resources, and for roles, a trust policy saying who is allowed to assume them. Humans assume roles through SSO. Workloads get an identity from where they run: an instance profile on a VM, a task role in ECS, workload identity (EKS Pod Identity or IRSA, GKE Workload Identity, Azure Workload Identity) in Kubernetes. The SDK picks up short-lived credentials automatically, and no key ever exists to leak.

CI should work the same way. GitHub Actions, GitLab, and most CI systems can present an OIDC token that the cloud exchanges for temporary credentials. The trust policy restricts it to a specific repository, branch, or environment. Static access keys in CI secrets are the thing this replaces.

- One role per service per environment, with only the actions it uses on only the resources it touches.
- Scope OIDC trust to the repo and branch or environment. A trust policy that accepts any repository in the organization lets any repo deploy to production.
- Require IMDSv2 (session tokens) for the instance metadata service on AWS. The metadata endpoint hands out the instance's credentials, and an SSRF bug in the app is enough to steal them without it.

**When reviewing AI-written code:**
- `"Action": "*"`, `"Resource": "*"`, or broad managed policies like AdministratorAccess attached to an app role. Agents reach for these because they make the error go away.
- Access keys created for a workload or pasted into CI, where a role or OIDC federation should be used.
- OIDC trust policies with no `sub` condition, or a wildcard in it.

## Choosing compute

A ladder, from most managed to least:

- **Functions** (Lambda, Cloud Functions, Azure Functions). Per-invocation billing, scale to zero, execution time limits, cold starts. Good for event handlers, webhooks, scheduled jobs, and glue.
- **Managed containers** (Cloud Run, ECS on Fargate, Azure Container Apps). Give it an image, a port, CPU and memory, and scaling bounds. No cluster, no nodes. This is the closest a raw cloud gets to a PaaS and the right default for most web apps and workers.
- **Managed Kubernetes** (EKS, GKE, AKS). The control plane is run for you, and with GKE Autopilot or EKS Auto Mode the nodes largely are too. You still own manifests, add-ons, ingress, upgrades, and the knowledge to debug it.
- **VMs** (EC2, Compute Engine, Azure VMs), usually behind an autoscaling group built from an image. Full control and full responsibility for OS patching, hardening, and log shipping.

Kubernetes earns its cost when you have many services, a platform team or at least one person who knows it deeply, or needs the managed options do not meet (unusual networking, GPUs with specific scheduling, portability requirements). A small team with three services on Kubernetes is usually paying a tax for a capability it does not use. EKS alone is $73 a month per cluster in control plane fees before any workloads run.

## Kubernetes working knowledge

Even teams that do not choose Kubernetes end up reading manifests. The core objects:

- **Pod**: one or more containers scheduled together. Disposable. Never create them directly.
- **Deployment**: keeps N identical pods running and rolls them to a new image. StatefulSet is the variant for pods that need stable identity and storage, and databases rarely belong in one when a managed database exists.
- **Service**: a stable internal name and IP in front of a set of pods, selected by labels.
- **Ingress and Gateway API**: how HTTP traffic from outside reaches Services. Gateway API is the successor, and the popular ingress-nginx controller was retired in March 2026 with no further security patches. Clusters still running it need a migration plan.
- **ConfigMap and Secret**: configuration mounted as files or env vars. A Secret is base64, not encryption. Anyone who can read Secrets in the namespace can read the values. Many teams sync them from the cloud secret manager with the External Secrets Operator.
- **Namespace**: a grouping for access control, quotas, and names. Not a security boundary on its own.
- **Probes**: liveness, readiness, and startup. The same rules as elsewhere: readiness means can serve now, liveness never depends on another service, and a slow-booting app needs a startup probe so liveness does not kill it mid-boot.
- **PodDisruptionBudget**: how many replicas may be down during voluntary disruptions like node upgrades. Without one, a node drain can take every replica at once.

Manifests are usually templated with Helm or Kustomize and applied by CI or a GitOps controller, never by hand from a laptop.

**Gets you burned:**
- Running one replica. Every node upgrade is then an outage.
- The `latest` tag in a manifest, so a pod rescheduled next week pulls a different image.
- Image pulls from Docker Hub without authentication. Anonymous pulls are capped at 100 per 6 hours per IP, and a whole cluster behind one NAT shares that. Mirror images into your own registry.

## Resource requests and limits

Every container should declare what it needs. The request is what the scheduler reserves, and it decides placement and the cost of the cluster. The limit is the ceiling. The two resources behave differently when the ceiling is hit.

Memory is not compressible. A container over its memory limit is OOM-killed and restarted. Set the memory request close to the limit, based on observed usage plus headroom. CPU is compressible. A container at its CPU limit is throttled, which shows up as latency spikes even while the node has idle cores. The common practice is to set CPU requests accurately and set CPU limits generously or not at all for latency-sensitive services.

- Set requests from real usage over a week, not guesses. Requests far above usage waste money. Requests far below usage overload nodes.
- Runtime awareness matters. Some runtimes size thread pools or heaps from the host's CPU and memory rather than the container's limits unless configured. Check yours.
- `OOMKilled` in pod status and restarts climbing in a sawtooth are the signals. See memory leaks on the performance page.

## Autoscaling

Scaling happens at two layers. Workload scaling changes the number of copies of your app: the Horizontal Pod Autoscaler in Kubernetes, service autoscaling on Cloud Run or ECS, autoscaling groups for VMs. Capacity scaling adds or removes the machines underneath: Karpenter or the Cluster Autoscaler in Kubernetes, and nothing at all on serverless options where the provider does it.

The hard part is the signal. CPU is a decent proxy for request-serving apps that are CPU-bound, and a poor one for apps that mostly wait on I/O. Queue workers should scale on queue depth or age of the oldest message, which is what KEDA exists to feed into Kubernetes, including scaling to zero.

- Set a minimum above one for production and a maximum that the database can survive. Autoscaling app servers to 50 instances with 20 connections each is 1,000 database connections.
- Scale out fast and scale in slowly, or the fleet flaps.
- New instances take time to become ready. Autoscaling absorbs gradual growth, not a spike that arrives in ten seconds. Keep headroom for those.

## Upgrades and version lifecycles

Every piece of infrastructure has a support window, and the window closing is a forcing function you will not get to schedule. Kubernetes ships three minor versions a year and patches each for about a year. Managed Kubernetes follows the same clock: EKS standard support covers 14 months, after which the cluster moves to extended support and the control plane fee rises sixfold, from $0.10 to $0.60 an hour. Managed databases do the same with engine versions. Base images, Helm charts, and add-ons have their own vendors whose terms change. Bitnami moved most of its free images to an unmaintained legacy repository in 2025, which broke every chart and Dockerfile pinned to them.

- Keep an inventory of versions: cluster, node images, add-ons, database engines, base images. Put end-of-support dates in the calendar.
- Upgrade one minor version at a time, staging first, on a routine cadence. Skipping upgrades turns a small quarterly task into a multi-week project.
- Read deprecation notes before upgrading Kubernetes. Removed API versions break manifests and charts that still reference them.

## Managed databases and caches

RDS, Cloud SQL, Azure Database, and their cache equivalents take backups, patching, and failover off your plate. What remains is configuration, and the defaults are tuned for a demo.

- **Multi-AZ** means a synchronous standby in another zone that takes over on failure, usually in a minute or two. A classic standby is not readable and is not a read replica. Read replicas are asynchronous copies for read scaling and can lag.
- **Failover** changes which machine the DNS name points to. Apps must reconnect and must not cache DNS forever. Test a failover in staging and watch what your connection pool does.
- **Maintenance windows** are when the provider may restart the database for patches. Set one deliberately.
- **Parameters** such as `max_connections`, statement timeouts, and slow query logging live in a parameter group or flags. Change them in code, not in the console.
- **Deletion protection** on, and a final snapshot on delete. Both are single settings that turn an accidental `terraform destroy` into a non-event.
- Storage autoscaling on, with a maximum. A full disk takes a database down harder than high CPU does.

Instance size is the first scaling lever, same as the performance page says. A bigger instance class is a few minutes of downtime or a failover away.

## Object storage

S3, Cloud Storage, and Blob Storage hold files: uploads, exports, static assets, backups. They are cheap, durable, and the source of a long list of public data leaks.

- Block Public Access stays on at the account level. New AWS buckets have had it on by default since 2023. Public content goes through a CDN in front of a private bucket.
- Users upload and download through presigned URLs, short-lived and scoped to one object. The app never proxies large files through its own servers.
- Lifecycle rules move old objects to cheaper storage classes and delete what should not be kept forever. Without them the bucket is the fastest-growing line on the bill.
- Versioning on for anything you cannot regenerate, so an overwrite or delete can be undone.
- Never trust the filename or content type from an upload. Generate the key server-side.

## Secrets and configuration

In the cloud, secrets live in a managed secret store (AWS Secrets Manager or Parameter Store, GCP Secret Manager, Azure Key Vault, or Vault). The workload's IAM role grants read access to exactly its own secrets, and the platform injects them as env vars or files at start. Encryption keys live in the key management service (KMS), and most services encrypt at rest with a provider-managed key by default.

- Access to read a secret is logged. That audit trail is part of the value.
- Rotation is easy for secrets the provider manages (database passwords with built-in rotation) and manual for third-party API keys. Know which is which.
- Terraform state holds every secret it touches in plain text. Prefer letting the database generate and manage its own master password in the secret store over passing one through Terraform variables.

## Terraform in practice

The DevOps page covers what IaC is. Working in a real Terraform (or OpenTofu) codebase:

- **State** lives remotely, locked during applies, one state per environment. The S3 backend supports native lockfiles (`use_lockfile`) since Terraform 1.11, and the old DynamoDB lock table is deprecated.
- **Modules** package a pattern (a service, a database with its alarms) and are instantiated per environment with different inputs. Keep them shallow. Modules nested five deep are impossible to reason about in a plan.
- **Environments** as separate root directories or workspaces calling the same modules. The code differs only in input values, just like the app.
- **Plan in the PR, apply on merge**, run by CI with an OIDC role. Humans do not apply from laptops against production.
- **Protect stateful resources** with `prevent_destroy` and the provider's own deletion protection. Renaming a resource in code destroys and recreates it unless you add a `moved` block.
- **Import** resources that were created by hand rather than recreating them. Import blocks make this reviewable.
- **Terraform vs OpenTofu**: Terraform has been under the Business Source License since 2023 and is owned by IBM. OpenTofu is the MPL-licensed fork under the Linux Foundation, and the two have diverged in features. Either is fine for an app team. Pick one per codebase.

**When reviewing AI-written code:**
- Read the plan, not just the diff. Look for `must be replaced` on databases, buckets, and load balancers, and for anything being destroyed.
- `0.0.0.0/0` ingress, `publicly_accessible = true`, public bucket policies, and IAM wildcards.
- Hardcoded account IDs, AMI IDs, zone names, and CIDRs where a variable or data source belongs.
- Missing tags, missing deletion protection, missing backup retention on new stateful resources.
- Provider and module versions left unpinned.

## GitOps at a glance

GitOps means the desired state of a cluster lives in a Git repository and a controller inside the cluster (Argo CD, Flux) continuously makes reality match it. CI builds and pushes the image, then commits the new tag to the config repo. The controller notices and rolls it out. Drift from a manual `kubectl edit` is reverted automatically, rollback is a revert commit, and the Git history is the deploy log. Worth it once you run Kubernetes seriously. Irrelevant on managed containers, where CI calling the deploy API does the same job.

## Disaster recovery

Two numbers define it. RPO (recovery point objective) is how much data you can afford to lose, measured in time. RTO (recovery time objective) is how long you can afford to be down. Point-in-time recovery on a managed database gives an RPO of minutes. RTO depends on how fast you can stand everything else back up, which is where infrastructure as code pays for itself.

- Decide the numbers with the business, then check the design meets them. Most apps need a few minutes of RPO and a few hours of RTO, which a single region with good backups delivers.
- Copy backups to a separate account, and to another region if a regional outage is in scope. A compromised production account should not be able to delete them.
- Run a restore drill at least twice a year: restore the database to a new instance, point a staging app at it, time it. The first drill always finds something.
- Rebuild an environment from code occasionally. If that fails, you do not have infrastructure as code, you have documentation.

## Where the infrastructure bill actually goes

Beyond compute, the lines that surprise teams moving off a PaaS:

- NAT gateway hours and per-GB processing, especially for traffic to the cloud's own services.
- Cross-zone data transfer between app, cache, and database spread across zones.
- Internet egress, which is priced far above ingress.
- Idle load balancers, unattached volumes, old snapshots, and public IPv4 addresses nobody released.
- Kubernetes clusters that fell out of standard support.
- Log ingestion and retention, usually larger than expected.
- Overprovisioned requests, where the cluster reserves three times what pods use.

Cost allocation tags, a monthly look at the top lines, and a budget alert per account catch nearly all of it.

## Key takeaways

- On a raw cloud, you own everything you configure. Default to the most managed option that works.
- Separate accounts per environment, SSO to roles, audit logs and budget alerts from day one.
- Run across zones in one region. Multi-region is rarely the fix, tested backups usually are.
- Private subnets for apps and databases, non-overlapping CIDRs, and watch the NAT gateway bill.
- Security groups reference each other, and `0.0.0.0/0` belongs only on the public load balancer.
- Workloads and CI get short-lived credentials from roles and OIDC, never static keys.
- IAM wildcards are the most common flaw in generated infrastructure code.
- Managed containers are the right default. Kubernetes needs a reason and a person.
- Set memory requests near limits, CPU requests accurately, and CPU limits loosely.
- Autoscale on the right signal and cap it at what the database can survive.
- Every version has an end-of-support date. Upgrade on a cadence, one step at a time.
- Deletion protection and final snapshots on every stateful resource.
- Buckets private, uploads through presigned URLs, lifecycle rules on.
- Read the Terraform plan, and treat `must be replaced` on stateful resources as a stop sign.
- Define RPO and RTO, then prove them with a restore drill.
