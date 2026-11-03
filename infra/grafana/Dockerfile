# syntax=docker/dockerfile:1

FROM postgres:16-alpine AS database-setup
COPY infra/metrics /opt/metrics
CMD ["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--file=/opt/metrics/setup.sql"]

FROM grafana/grafana:13.3.0 AS grafana
COPY infra/grafana/grafana.ini /etc/grafana/grafana.ini
COPY infra/grafana/provisioning /etc/grafana/provisioning
COPY infra/grafana/dashboards /etc/grafana/dashboards
