-- PostgreSQL foreign-key indexes for Helix.
--
-- PostgreSQL does not create an index for a foreign key automatically, so every
-- FK column is given a supporting btree index. This keeps referential-integrity
-- checks (parent DELETE/UPDATE) and FK joins off sequential scans. Derived from
-- the foreign keys declared in schema.sql; regenerate after schema changes.

CREATE INDEX IF NOT EXISTS idx_approval_rules_rollback_state_id ON approval_rules(rollback_state_id);

CREATE INDEX IF NOT EXISTS idx_bom_baseline_lines_tenant_id ON bom_baseline_lines(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_baselines_created_by ON bom_baselines(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_baselines_frozen_by ON bom_baselines(frozen_by);

CREATE INDEX IF NOT EXISTS idx_bom_baselines_organization_id ON bom_baselines(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_change_history_actor_user_id ON bom_change_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_bom_comparison_results_tenant_id ON bom_comparison_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_comparisons_created_by ON bom_comparisons(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_comparisons_organization_id ON bom_comparisons(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_configuration_updated_by ON bom_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_bom_headers_created_by ON bom_headers(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_headers_updated_by ON bom_headers(updated_by);

CREATE INDEX IF NOT EXISTS idx_bom_line_attributes_tenant_id ON bom_line_attributes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_lines_created_by ON bom_lines(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_lines_updated_by ON bom_lines(updated_by);

CREATE INDEX IF NOT EXISTS idx_bom_revisions_created_by ON bom_revisions(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_revisions_organization_id ON bom_revisions(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_revisions_owner_user_id ON bom_revisions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_bom_revisions_updated_by ON bom_revisions(updated_by);

CREATE INDEX IF NOT EXISTS idx_bom_substitutes_created_by ON bom_substitutes(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_substitutes_organization_id ON bom_substitutes(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_substitutes_tenant_id ON bom_substitutes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_definitions_created_by ON bom_transformation_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_definitions_organization_id ON bom_transformation_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_definitions_updated_by ON bom_transformation_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_mappings_tenant_id ON bom_transformation_mappings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_runs_created_by ON bom_transformation_runs(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_runs_organization_id ON bom_transformation_runs(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_runs_source_revision_id ON bom_transformation_runs(source_revision_id);

CREATE INDEX IF NOT EXISTS idx_bom_transformation_runs_tenant_id ON bom_transformation_runs(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_issues_tenant_id ON bom_validation_issues(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_results_actor_user_id ON bom_validation_results(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_results_bom_id ON bom_validation_results(bom_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_results_organization_id ON bom_validation_results(organization_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_results_tenant_id ON bom_validation_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_bom_validation_rules_created_by ON bom_validation_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_bom_validation_rules_updated_by ON bom_validation_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_change_affected_items_created_by ON change_affected_items(created_by);

CREATE INDEX IF NOT EXISTS idx_change_affected_items_tenant_id ON change_affected_items(tenant_id);

CREATE INDEX IF NOT EXISTS idx_change_configuration_updated_by ON change_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_change_history_organization_id ON change_history(organization_id);

CREATE INDEX IF NOT EXISTS idx_change_notices_created_by ON change_notices(created_by);

CREATE INDEX IF NOT EXISTS idx_change_notices_issued_by ON change_notices(issued_by);

CREATE INDEX IF NOT EXISTS idx_change_notices_organization_id ON change_notices(organization_id);

CREATE INDEX IF NOT EXISTS idx_change_notices_updated_by ON change_notices(updated_by);

CREATE INDEX IF NOT EXISTS idx_change_orders_created_by ON change_orders(created_by);

CREATE INDEX IF NOT EXISTS idx_change_orders_organization_id ON change_orders(organization_id);

CREATE INDEX IF NOT EXISTS idx_change_orders_released_by ON change_orders(released_by);

CREATE INDEX IF NOT EXISTS idx_change_orders_requested_by ON change_orders(requested_by);

CREATE INDEX IF NOT EXISTS idx_change_orders_updated_by ON change_orders(updated_by);

CREATE INDEX IF NOT EXISTS idx_change_relationships_created_by ON change_relationships(created_by);

CREATE INDEX IF NOT EXISTS idx_change_requests_created_by ON change_requests(created_by);

CREATE INDEX IF NOT EXISTS idx_change_requests_organization_id ON change_requests(organization_id);

CREATE INDEX IF NOT EXISTS idx_change_requests_requested_by ON change_requests(requested_by);

CREATE INDEX IF NOT EXISTS idx_change_requests_updated_by ON change_requests(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_allowed_values_created_by ON cla_allowed_values(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_allowed_values_tenant_id ON cla_allowed_values(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_allowed_values_updated_by ON cla_allowed_values(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_assignment_values_created_by ON cla_assignment_values(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_assignment_values_tenant_id ON cla_assignment_values(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_assignment_values_updated_by ON cla_assignment_values(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_assignments_organization_id ON cla_assignments(organization_id);

CREATE INDEX IF NOT EXISTS idx_cla_change_history_actor_user_id ON cla_change_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_cla_change_history_organization_id ON cla_change_history(organization_id);

CREATE INDEX IF NOT EXISTS idx_cla_characteristic_group_members_tenant_id ON cla_characteristic_group_members(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_characteristic_groups_created_by ON cla_characteristic_groups(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_characteristic_groups_updated_by ON cla_characteristic_groups(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_characteristic_versions_created_by ON cla_characteristic_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_characteristic_versions_tenant_id ON cla_characteristic_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_characteristics_created_by ON cla_characteristics(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_characteristics_updated_by ON cla_characteristics(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_class_characteristics_created_by ON cla_class_characteristics(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_class_characteristics_tenant_id ON cla_class_characteristics(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_class_characteristics_updated_by ON cla_class_characteristics(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_class_versions_created_by ON cla_class_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_class_versions_tenant_id ON cla_class_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_classes_created_by ON cla_classes(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_classes_owner_user_id ON cla_classes(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_cla_classes_updated_by ON cla_classes(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_classification_versions_created_by ON cla_classification_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_classification_versions_tenant_id ON cla_classification_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_classifications_created_by ON cla_classifications(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_classifications_organization_id ON cla_classifications(organization_id);

CREATE INDEX IF NOT EXISTS idx_cla_classifications_steward_user_id ON cla_classifications(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_cla_classifications_updated_by ON cla_classifications(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_configuration_updated_by ON cla_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_cla_rules_created_by ON cla_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_cla_rules_tenant_id ON cla_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_cla_rules_updated_by ON cla_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_content_created_by ON content(created_by);

CREATE INDEX IF NOT EXISTS idx_content_dedupe_of_content_id ON content(dedupe_of_content_id);

CREATE INDEX IF NOT EXISTS idx_content_deleted_by ON content(deleted_by);

CREATE INDEX IF NOT EXISTS idx_content_organization_id ON content(organization_id);

CREATE INDEX IF NOT EXISTS idx_content_updated_by ON content(updated_by);

CREATE INDEX IF NOT EXISTS idx_content_associations_created_by ON content_associations(created_by);

CREATE INDEX IF NOT EXISTS idx_content_associations_organization_id ON content_associations(organization_id);

CREATE INDEX IF NOT EXISTS idx_content_associations_updated_by ON content_associations(updated_by);

CREATE INDEX IF NOT EXISTS idx_content_legal_holds_applied_by ON content_legal_holds(applied_by);

CREATE INDEX IF NOT EXISTS idx_content_legal_holds_released_by ON content_legal_holds(released_by);

CREATE INDEX IF NOT EXISTS idx_content_legal_holds_tenant_id ON content_legal_holds(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_locks_released_by ON content_locks(released_by);

CREATE INDEX IF NOT EXISTS idx_content_locks_tenant_id ON content_locks(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_processing_jobs_rendition_id ON content_processing_jobs(rendition_id);

CREATE INDEX IF NOT EXISTS idx_content_processing_jobs_tenant_id ON content_processing_jobs(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_processing_jobs_version_id ON content_processing_jobs(version_id);

CREATE INDEX IF NOT EXISTS idx_content_renditions_requested_by ON content_renditions(requested_by);

CREATE INDEX IF NOT EXISTS idx_content_renditions_source_content_id ON content_renditions(source_content_id);

CREATE INDEX IF NOT EXISTS idx_content_renditions_source_version_id ON content_renditions(source_version_id);

CREATE INDEX IF NOT EXISTS idx_content_renditions_tenant_id ON content_renditions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_retention_policies_created_by ON content_retention_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_content_retention_policies_tenant_id ON content_retention_policies(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_retention_records_created_by ON content_retention_records(created_by);

CREATE INDEX IF NOT EXISTS idx_content_retention_records_policy_id ON content_retention_records(policy_id);

CREATE INDEX IF NOT EXISTS idx_content_retention_records_tenant_id ON content_retention_records(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_security_scans_tenant_id ON content_security_scans(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_security_scans_version_id ON content_security_scans(version_id);

CREATE INDEX IF NOT EXISTS idx_content_storage_references_tenant_id ON content_storage_references(tenant_id);

CREATE INDEX IF NOT EXISTS idx_content_storage_references_version_id ON content_storage_references(version_id);

CREATE INDEX IF NOT EXISTS idx_content_upload_sessions_created_by ON content_upload_sessions(created_by);

CREATE INDEX IF NOT EXISTS idx_content_upload_sessions_organization_id ON content_upload_sessions(organization_id);

CREATE INDEX IF NOT EXISTS idx_content_upload_sessions_updated_by ON content_upload_sessions(updated_by);

CREATE INDEX IF NOT EXISTS idx_content_versions_created_by ON content_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_content_versions_previous_version_id ON content_versions(previous_version_id);

CREATE INDEX IF NOT EXISTS idx_content_versions_restored_from_version_id ON content_versions(restored_from_version_id);

CREATE INDEX IF NOT EXISTS idx_content_versions_tenant_id ON content_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_approved_by ON dc_business_terms(approved_by);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_created_by ON dc_business_terms(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_domain_id ON dc_business_terms(domain_id);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_entry_id ON dc_business_terms(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_owner_user_id ON dc_business_terms(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_steward_user_id ON dc_business_terms(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_business_terms_updated_by ON dc_business_terms(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_created_by ON dc_catalog_attributes(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_domain_id ON dc_catalog_attributes(domain_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_entry_id ON dc_catalog_attributes(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_object_id ON dc_catalog_attributes(object_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_owner_user_id ON dc_catalog_attributes(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_steward_user_id ON dc_catalog_attributes(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_attributes_updated_by ON dc_catalog_attributes(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_created_by ON dc_catalog_objects(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_domain_id ON dc_catalog_objects(domain_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_entry_id ON dc_catalog_objects(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_owner_user_id ON dc_catalog_objects(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_steward_user_id ON dc_catalog_objects(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_catalog_objects_updated_by ON dc_catalog_objects(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_classification_assignments_assigned_by ON dc_classification_assignments(assigned_by);

CREATE INDEX IF NOT EXISTS idx_dc_classification_assignments_classification_id ON dc_classification_assignments(classification_id);

CREATE INDEX IF NOT EXISTS idx_dc_classification_assignments_entry_id ON dc_classification_assignments(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_classifications_created_by ON dc_classifications(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_configuration_updated_by ON dc_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_attribute_id ON dc_consumer_mappings(attribute_id);

CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_consumer_id ON dc_consumer_mappings(consumer_id);

CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_created_by ON dc_consumer_mappings(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_consumer_mappings_object_id ON dc_consumer_mappings(object_id);

CREATE INDEX IF NOT EXISTS idx_dc_consumers_created_by ON dc_consumers(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_consumers_entry_id ON dc_consumers(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_consumers_owner_user_id ON dc_consumers(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_consumers_updated_by ON dc_consumers(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_entries_created_by ON dc_entries(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_entries_domain_id ON dc_entries(domain_id);

CREATE INDEX IF NOT EXISTS idx_dc_entries_organization_id ON dc_entries(organization_id);

CREATE INDEX IF NOT EXISTS idx_dc_entries_owner_user_id ON dc_entries(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_entries_steward_user_id ON dc_entries(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_entries_updated_by ON dc_entries(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_import_runs_created_by ON dc_import_runs(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_lineage_created_by ON dc_lineage(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_metadata_versions_created_by ON dc_metadata_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_ownership_created_by ON dc_ownership(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_ownership_entry_id ON dc_ownership(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_relationships_created_by ON dc_relationships(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_relationships_from_entry_id ON dc_relationships(from_entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_relationships_relationship_type_id ON dc_relationships(relationship_type_id);

CREATE INDEX IF NOT EXISTS idx_dc_relationships_to_entry_id ON dc_relationships(to_entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_created_by ON dc_source_mappings(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_owner_user_id ON dc_source_mappings(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_source_id ON dc_source_mappings(source_id);

CREATE INDEX IF NOT EXISTS idx_dc_source_mappings_target_entry_id ON dc_source_mappings(target_entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_sources_created_by ON dc_sources(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_sources_entry_id ON dc_sources(entry_id);

CREATE INDEX IF NOT EXISTS idx_dc_sources_owner_user_id ON dc_sources(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dc_sources_updated_by ON dc_sources(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_term_definitions_created_by ON dc_term_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_term_definitions_tenant_id ON dc_term_definitions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_dc_term_definitions_updated_by ON dc_term_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_dc_term_mappings_created_by ON dc_term_mappings(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_term_relations_created_by ON dc_term_relations(created_by);

CREATE INDEX IF NOT EXISTS idx_dc_term_relations_related_term_id ON dc_term_relations(related_term_id);

CREATE INDEX IF NOT EXISTS idx_delivery_alerts_acknowledged_by ON delivery_alerts(acknowledged_by);

CREATE INDEX IF NOT EXISTS idx_delivery_alerts_request_id ON delivery_alerts(request_id);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_provider_id ON delivery_attempts(provider_id);

CREATE INDEX IF NOT EXISTS idx_delivery_escalations_organization_id ON delivery_escalations(organization_id);

CREATE INDEX IF NOT EXISTS idx_delivery_escalations_recipient_id ON delivery_escalations(recipient_id);

CREATE INDEX IF NOT EXISTS idx_delivery_escalations_reminder_id ON delivery_escalations(reminder_id);

CREATE INDEX IF NOT EXISTS idx_delivery_escalations_tenant_id ON delivery_escalations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_delivery_provider_failures_provider_id ON delivery_provider_failures(provider_id);

CREATE INDEX IF NOT EXISTS idx_delivery_provider_failures_request_id ON delivery_provider_failures(request_id);

CREATE INDEX IF NOT EXISTS idx_delivery_provider_failures_tenant_id ON delivery_provider_failures(tenant_id);

CREATE INDEX IF NOT EXISTS idx_delivery_rate_events_tenant_id ON delivery_rate_events(tenant_id);

CREATE INDEX IF NOT EXISTS idx_delivery_reminders_created_by ON delivery_reminders(created_by);

CREATE INDEX IF NOT EXISTS idx_delivery_reminders_organization_id ON delivery_reminders(organization_id);

CREATE INDEX IF NOT EXISTS idx_delivery_reminders_recipient_id ON delivery_reminders(recipient_id);

CREATE INDEX IF NOT EXISTS idx_delivery_requests_created_by ON delivery_requests(created_by);

CREATE INDEX IF NOT EXISTS idx_delivery_requests_organization_id ON delivery_requests(organization_id);

CREATE INDEX IF NOT EXISTS idx_delivery_requests_provider_id ON delivery_requests(provider_id);

CREATE INDEX IF NOT EXISTS idx_delivery_runs_request_id ON delivery_runs(request_id);

CREATE INDEX IF NOT EXISTS idx_deployment_features_updated_by ON deployment_features(updated_by);

CREATE INDEX IF NOT EXISTS idx_deployment_history_actor_user_id ON deployment_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_deployment_profile_updated_by ON deployment_profile(updated_by);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_attributes_object_id ON dg_catalog_attributes(object_id);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_objects_created_by ON dg_catalog_objects(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_objects_domain_id ON dg_catalog_objects(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_catalog_objects_updated_by ON dg_catalog_objects(updated_by);

CREATE INDEX IF NOT EXISTS idx_dg_configuration_updated_by ON dg_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_dg_domains_created_by ON dg_domains(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_domains_organization_id ON dg_domains(organization_id);

CREATE INDEX IF NOT EXISTS idx_dg_domains_owner_organization_id ON dg_domains(owner_organization_id);

CREATE INDEX IF NOT EXISTS idx_dg_domains_owner_user_id ON dg_domains(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_domains_secondary_owner_user_id ON dg_domains(secondary_owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_domains_steward_user_id ON dg_domains(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_domains_updated_by ON dg_domains(updated_by);

CREATE INDEX IF NOT EXISTS idx_dg_duplicate_candidates_domain_id ON dg_duplicate_candidates(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_duplicate_candidates_match_rule_id ON dg_duplicate_candidates(match_rule_id);

CREATE INDEX IF NOT EXISTS idx_dg_duplicate_candidates_resolved_by ON dg_duplicate_candidates(resolved_by);

CREATE INDEX IF NOT EXISTS idx_dg_duplicate_match_rules_created_by ON dg_duplicate_match_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_duplicate_match_rules_domain_id ON dg_duplicate_match_rules(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_exception_comments_author_id ON dg_exception_comments(author_id);

CREATE INDEX IF NOT EXISTS idx_dg_exception_comments_exception_id ON dg_exception_comments(exception_id);

CREATE INDEX IF NOT EXISTS idx_dg_ownership_created_by ON dg_ownership(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_ownership_domain_id ON dg_ownership(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_policies_created_by ON dg_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_policies_domain_id ON dg_policies(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_policies_owner_user_id ON dg_policies(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_policies_steward_user_id ON dg_policies(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_policies_updated_by ON dg_policies(updated_by);

CREATE INDEX IF NOT EXISTS idx_dg_policy_versions_created_by ON dg_policy_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_assignee_organization_id ON dg_quality_exceptions(assignee_organization_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_assignee_user_id ON dg_quality_exceptions(assignee_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_closed_by ON dg_quality_exceptions(closed_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_created_by ON dg_quality_exceptions(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_domain_id ON dg_quality_exceptions(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_organization_id ON dg_quality_exceptions(organization_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_owner_user_id ON dg_quality_exceptions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_plant_id ON dg_quality_exceptions(plant_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_resolved_by ON dg_quality_exceptions(resolved_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_rule_id ON dg_quality_exceptions(rule_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_steward_user_id ON dg_quality_exceptions(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_verified_by ON dg_quality_exceptions(verified_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_exceptions_waived_by ON dg_quality_exceptions(waived_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_jobs_submitted_by ON dg_quality_jobs(submitted_by);

CREATE INDEX IF NOT EXISTS idx_dg_quality_results_domain_id ON dg_quality_results(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_results_organization_id ON dg_quality_results(organization_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_results_plant_id ON dg_quality_results(plant_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_violations_domain_id ON dg_quality_violations(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_violations_result_id ON dg_quality_violations(result_id);

CREATE INDEX IF NOT EXISTS idx_dg_quality_violations_rule_id ON dg_quality_violations(rule_id);

CREATE INDEX IF NOT EXISTS idx_dg_remediations_exception_id ON dg_remediations(exception_id);

CREATE INDEX IF NOT EXISTS idx_dg_remediations_executed_by ON dg_remediations(executed_by);

CREATE INDEX IF NOT EXISTS idx_dg_remediations_requested_by ON dg_remediations(requested_by);

CREATE INDEX IF NOT EXISTS idx_dg_rule_versions_created_by ON dg_rule_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_rules_created_by ON dg_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_dg_rules_domain_id ON dg_rules(domain_id);

CREATE INDEX IF NOT EXISTS idx_dg_rules_owner_user_id ON dg_rules(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_rules_policy_id ON dg_rules(policy_id);

CREATE INDEX IF NOT EXISTS idx_dg_rules_steward_user_id ON dg_rules(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_dg_rules_updated_by ON dg_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_event_dead_letters_event_id ON event_dead_letters(event_id);

CREATE INDEX IF NOT EXISTS idx_event_queues_created_by ON event_queues(created_by);

CREATE INDEX IF NOT EXISTS idx_event_registry_created_by ON event_registry(created_by);

CREATE INDEX IF NOT EXISTS idx_event_schemas_created_by ON event_schemas(created_by);

CREATE INDEX IF NOT EXISTS idx_event_subscriptions_created_by ON event_subscriptions(created_by);

CREATE INDEX IF NOT EXISTS idx_event_topics_created_by ON event_topics(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_configuration_updated_by ON exchange_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_definition_versions_created_by ON exchange_definition_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_definition_versions_tenant_id ON exchange_definition_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_exchange_definitions_created_by ON exchange_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_definitions_organization_id ON exchange_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_exchange_definitions_owner_user_id ON exchange_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_exchange_definitions_published_by ON exchange_definitions(published_by);

CREATE INDEX IF NOT EXISTS idx_exchange_definitions_updated_by ON exchange_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_format_versions_created_by ON exchange_format_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_format_versions_tenant_id ON exchange_format_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_exchange_formats_created_by ON exchange_formats(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_formats_updated_by ON exchange_formats(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_history_actor_user_id ON exchange_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_exchange_history_organization_id ON exchange_history(organization_id);

CREATE INDEX IF NOT EXISTS idx_exchange_job_results_tenant_id ON exchange_job_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_exchange_mapping_versions_created_by ON exchange_mapping_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_mapping_versions_tenant_id ON exchange_mapping_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_exchange_mappings_created_by ON exchange_mappings(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_mappings_updated_by ON exchange_mappings(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_transactions_created_by ON exchange_transactions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_transactions_organization_id ON exchange_transactions(organization_id);

CREATE INDEX IF NOT EXISTS idx_exchange_transformation_versions_created_by ON exchange_transformation_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_transformation_versions_tenant_id ON exchange_transformation_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_exchange_transformations_created_by ON exchange_transformations(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_transformations_updated_by ON exchange_transformations(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_validation_profiles_created_by ON exchange_validation_profiles(created_by);

CREATE INDEX IF NOT EXISTS idx_exchange_validation_profiles_updated_by ON exchange_validation_profiles(updated_by);

CREATE INDEX IF NOT EXISTS idx_exchange_validation_rules_tenant_id ON exchange_validation_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_external_systems_credential_id ON external_systems(credential_id);

CREATE INDEX IF NOT EXISTS idx_file_associations_created_by ON file_associations(created_by);

CREATE INDEX IF NOT EXISTS idx_file_associations_deleted_by ON file_associations(deleted_by);

CREATE INDEX IF NOT EXISTS idx_file_associations_organization_id ON file_associations(organization_id);

CREATE INDEX IF NOT EXISTS idx_file_collection_members_added_by ON file_collection_members(added_by);

CREATE INDEX IF NOT EXISTS idx_file_collections_created_by ON file_collections(created_by);

CREATE INDEX IF NOT EXISTS idx_file_collections_organization_id ON file_collections(organization_id);

CREATE INDEX IF NOT EXISTS idx_file_collections_owner_id ON file_collections(owner_id);

CREATE INDEX IF NOT EXISTS idx_file_collections_updated_by ON file_collections(updated_by);

CREATE INDEX IF NOT EXISTS idx_file_events_actor_id ON file_events(actor_id);

CREATE INDEX IF NOT EXISTS idx_file_events_organization_id ON file_events(organization_id);

CREATE INDEX IF NOT EXISTS idx_file_events_version_id ON file_events(version_id);

CREATE INDEX IF NOT EXISTS idx_file_locks_released_by ON file_locks(released_by);

CREATE INDEX IF NOT EXISTS idx_file_locks_tenant_id ON file_locks(tenant_id);

CREATE INDEX IF NOT EXISTS idx_file_permissions_granted_by ON file_permissions(granted_by);

CREATE INDEX IF NOT EXISTS idx_file_permissions_tenant_id ON file_permissions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_file_processing_tenant_id ON file_processing(tenant_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_created_by ON file_uploads(created_by);

CREATE INDEX IF NOT EXISTS idx_file_uploads_duplicate_of_file_id ON file_uploads(duplicate_of_file_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_folder_id ON file_uploads(folder_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_organization_id ON file_uploads(organization_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_updated_by ON file_uploads(updated_by);

CREATE INDEX IF NOT EXISTS idx_file_versions_created_by ON file_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_file_versions_previous_version_id ON file_versions(previous_version_id);

CREATE INDEX IF NOT EXISTS idx_file_versions_restored_from_version_id ON file_versions(restored_from_version_id);

CREATE INDEX IF NOT EXISTS idx_files_created_by ON files(created_by);

CREATE INDEX IF NOT EXISTS idx_files_deleted_by ON files(deleted_by);

CREATE INDEX IF NOT EXISTS idx_files_updated_by ON files(updated_by);

CREATE INDEX IF NOT EXISTS idx_folders_created_by ON folders(created_by);

CREATE INDEX IF NOT EXISTS idx_folders_deleted_by ON folders(deleted_by);

CREATE INDEX IF NOT EXISTS idx_folders_organization_id ON folders(organization_id);

CREATE INDEX IF NOT EXISTS idx_folders_owner_id ON folders(owner_id);

CREATE INDEX IF NOT EXISTS idx_folders_updated_by ON folders(updated_by);

CREATE INDEX IF NOT EXISTS idx_group_roles_role_id ON group_roles(role_id);

CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON groups(organization_id);

CREATE INDEX IF NOT EXISTS idx_groups_parent_id ON groups(parent_id);

CREATE INDEX IF NOT EXISTS idx_ie_configuration_updated_by ON ie_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_ie_connector_configurations_created_by ON ie_connector_configurations(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_connector_configurations_organization_id ON ie_connector_configurations(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_connector_configurations_updated_by ON ie_connector_configurations(updated_by);

CREATE INDEX IF NOT EXISTS idx_ie_connector_credential_references_created_by ON ie_connector_credential_references(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_export_definition_versions_created_by ON ie_export_definition_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_export_definition_versions_tenant_id ON ie_export_definition_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_definitions_created_by ON ie_export_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_export_definitions_organization_id ON ie_export_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_definitions_owner_user_id ON ie_export_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_definitions_updated_by ON ie_export_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_ie_export_field_selections_tenant_id ON ie_export_field_selections(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_filters_tenant_id ON ie_export_filters(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_history_actor_id ON ie_export_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_history_definition_id ON ie_export_history(definition_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_history_job_id ON ie_export_history(job_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_history_organization_id ON ie_export_history(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_jobs_created_by ON ie_export_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_export_jobs_organization_id ON ie_export_jobs(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_results_tenant_id ON ie_export_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_export_transformations_tenant_id ON ie_export_transformations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_batches_tenant_id ON ie_import_batches(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_checkpoints_tenant_id ON ie_import_checkpoints(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_definition_versions_created_by ON ie_import_definition_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_import_definition_versions_tenant_id ON ie_import_definition_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_definitions_connector_config_id ON ie_import_definitions(connector_config_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_definitions_created_by ON ie_import_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_import_definitions_organization_id ON ie_import_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_definitions_owner_user_id ON ie_import_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_definitions_updated_by ON ie_import_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_ie_import_errors_tenant_id ON ie_import_errors(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_history_actor_id ON ie_import_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_history_definition_id ON ie_import_history(definition_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_history_job_id ON ie_import_history(job_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_history_organization_id ON ie_import_history(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_jobs_created_by ON ie_import_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_import_jobs_organization_id ON ie_import_jobs(organization_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_mappings_tenant_id ON ie_import_mappings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_reconciliations_tenant_id ON ie_import_reconciliations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_record_results_tenant_id ON ie_import_record_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_transformations_tenant_id ON ie_import_transformations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_import_validation_rules_tenant_id ON ie_import_validation_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_ie_templates_created_by ON ie_templates(created_by);

CREATE INDEX IF NOT EXISTS idx_ie_templates_updated_by ON ie_templates(updated_by);

CREATE INDEX IF NOT EXISTS idx_integration_api_clients_credential_id ON integration_api_clients(credential_id);

CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_execution_id ON integration_dead_letters(execution_id);

CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_message_id ON integration_dead_letters(message_id);

CREATE INDEX IF NOT EXISTS idx_integration_definitions_credential_id ON integration_definitions(credential_id);

CREATE INDEX IF NOT EXISTS idx_integration_definitions_schedule_id ON integration_definitions(schedule_id);

CREATE INDEX IF NOT EXISTS idx_integration_definitions_target_system_id ON integration_definitions(target_system_id);

CREATE INDEX IF NOT EXISTS idx_integration_definitions_transformation_id ON integration_definitions(transformation_id);

CREATE INDEX IF NOT EXISTS idx_integration_endpoints_external_system_id ON integration_endpoints(external_system_id);

CREATE INDEX IF NOT EXISTS idx_integration_endpoints_integration_id ON integration_endpoints(integration_id);

CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_subscription_id ON integration_event_deliveries(subscription_id);

CREATE INDEX IF NOT EXISTS idx_integration_messages_integration_id ON integration_messages(integration_id);

CREATE INDEX IF NOT EXISTS idx_integration_transfers_integration_id ON integration_transfers(integration_id);

CREATE INDEX IF NOT EXISTS idx_integration_transfers_mapping_id ON integration_transfers(mapping_id);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_endpoints_credential_id ON integration_webhook_endpoints(credential_id);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_endpoints_integration_id ON integration_webhook_endpoints(integration_id);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_subscriptions_credential_id ON integration_webhook_subscriptions(credential_id);

CREATE INDEX IF NOT EXISTS idx_job_artifacts_created_by ON job_artifacts(created_by);

CREATE INDEX IF NOT EXISTS idx_job_dead_letters_job_id ON job_dead_letters(job_id);

CREATE INDEX IF NOT EXISTS idx_job_dead_letters_requeued_job_id ON job_dead_letters(requeued_job_id);

CREATE INDEX IF NOT EXISTS idx_job_dead_letters_resolved_by ON job_dead_letters(resolved_by);

CREATE INDEX IF NOT EXISTS idx_job_engine_audit_actor_id ON job_engine_audit(actor_id);

CREATE INDEX IF NOT EXISTS idx_job_history_actor_id ON job_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_job_queues_created_by ON job_queues(created_by);

CREATE INDEX IF NOT EXISTS idx_job_queues_updated_by ON job_queues(updated_by);

CREATE INDEX IF NOT EXISTS idx_job_schedules_created_by ON job_schedules(created_by);

CREATE INDEX IF NOT EXISTS idx_job_schedules_last_job_id ON job_schedules(last_job_id);

CREATE INDEX IF NOT EXISTS idx_job_schedules_organization_id ON job_schedules(organization_id);

CREATE INDEX IF NOT EXISTS idx_job_schedules_updated_by ON job_schedules(updated_by);

CREATE INDEX IF NOT EXISTS idx_job_types_created_by ON job_types(created_by);

CREATE INDEX IF NOT EXISTS idx_jobs_cancel_requested_by ON jobs(cancel_requested_by);

CREATE INDEX IF NOT EXISTS idx_jobs_organization_id ON jobs(organization_id);

CREATE INDEX IF NOT EXISTS idx_lc_archive_records_created_by ON lc_archive_records(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_configuration_updated_by ON lc_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_lc_history_actor_id ON lc_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_lc_legal_hold_scopes_hold_id ON lc_legal_hold_scopes(hold_id);

CREATE INDEX IF NOT EXISTS idx_lc_legal_holds_created_by ON lc_legal_holds(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_legal_holds_organization_id ON lc_legal_holds(organization_id);

CREATE INDEX IF NOT EXISTS idx_lc_legal_holds_released_by ON lc_legal_holds(released_by);

CREATE INDEX IF NOT EXISTS idx_lc_lifecycle_jobs_created_by ON lc_lifecycle_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_object_lifecycle_created_by ON lc_object_lifecycle(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_object_lifecycle_organization_id ON lc_object_lifecycle(organization_id);

CREATE INDEX IF NOT EXISTS idx_lc_object_lifecycle_retention_policy_id ON lc_object_lifecycle(retention_policy_id);

CREATE INDEX IF NOT EXISTS idx_lc_policies_created_by ON lc_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_policies_organization_id ON lc_policies(organization_id);

CREATE INDEX IF NOT EXISTS idx_lc_policies_owner_user_id ON lc_policies(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_lc_policies_updated_by ON lc_policies(updated_by);

CREATE INDEX IF NOT EXISTS idx_lc_policy_versions_created_by ON lc_policy_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_policy_versions_tenant_id ON lc_policy_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_lc_purge_records_executed_by ON lc_purge_records(executed_by);

CREATE INDEX IF NOT EXISTS idx_lc_recovery_records_requested_by ON lc_recovery_records(requested_by);

CREATE INDEX IF NOT EXISTS idx_lc_restore_records_archive_id ON lc_restore_records(archive_id);

CREATE INDEX IF NOT EXISTS idx_lc_restore_records_requested_by ON lc_restore_records(requested_by);

CREATE INDEX IF NOT EXISTS idx_lc_state_transitions_created_by ON lc_state_transitions(created_by);

CREATE INDEX IF NOT EXISTS idx_lc_states_created_by ON lc_states(created_by);

CREATE INDEX IF NOT EXISTS idx_lifecycle_states_status_id ON lifecycle_states(status_id);

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_to_state_id ON lifecycle_transitions(to_state_id);

CREATE INDEX IF NOT EXISTS idx_lifecycle_type_assignments_lifecycle_version_id ON lifecycle_type_assignments(lifecycle_version_id);

CREATE INDEX IF NOT EXISTS idx_lifecycle_type_assignments_tenant_id ON lifecycle_type_assignments(tenant_id);

CREATE INDEX IF NOT EXISTS idx_lifecycle_versions_created_by ON lifecycle_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_lifecycle_versions_published_by ON lifecycle_versions(published_by);

CREATE INDEX IF NOT EXISTS idx_metadata_attributes_lov_id ON metadata_attributes(lov_id);

CREATE INDEX IF NOT EXISTS idx_metadata_form_fields_attribute_id ON metadata_form_fields(attribute_id);

CREATE INDEX IF NOT EXISTS idx_metadata_form_nodes_parent_id ON metadata_form_nodes(parent_id);

CREATE INDEX IF NOT EXISTS idx_metadata_lovs_parent_lov_id ON metadata_lovs(parent_lov_id);

CREATE INDEX IF NOT EXISTS idx_metadata_type_attributes_attribute_id ON metadata_type_attributes(attribute_id);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_id ON mfa_challenges(user_id);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_id ON mfa_recovery_codes(user_id);

CREATE INDEX IF NOT EXISTS idx_mig_audit_actor_user_id ON mig_audit(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_mig_audit_batch_id ON mig_audit(batch_id);

CREATE INDEX IF NOT EXISTS idx_mig_audit_organization_id ON mig_audit(organization_id);

CREATE INDEX IF NOT EXISTS idx_mig_audit_package_id ON mig_audit(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_audit_project_id ON mig_audit(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_batches_tenant_id ON mig_batches(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_checkpoints_tenant_id ON mig_checkpoints(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_configuration_updated_by ON mig_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_mig_definition_versions_created_by ON mig_definition_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_definition_versions_tenant_id ON mig_definition_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_definitions_created_by ON mig_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_definitions_organization_id ON mig_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_mig_definitions_owner_user_id ON mig_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_mig_definitions_updated_by ON mig_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_mig_dependencies_depends_on_package_id ON mig_dependencies(depends_on_package_id);

CREATE INDEX IF NOT EXISTS idx_mig_dependencies_project_id ON mig_dependencies(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_dependencies_tenant_id ON mig_dependencies(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_errors_batch_id ON mig_errors(batch_id);

CREATE INDEX IF NOT EXISTS idx_mig_errors_package_id ON mig_errors(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_errors_resolved_by ON mig_errors(resolved_by);

CREATE INDEX IF NOT EXISTS idx_mig_errors_tenant_id ON mig_errors(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_file_migrations_package_id ON mig_file_migrations(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_file_migrations_project_id ON mig_file_migrations(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_file_migrations_tenant_id ON mig_file_migrations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_identifier_mappings_package_id ON mig_identifier_mappings(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_identifier_mappings_project_id ON mig_identifier_mappings(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_jobs_created_by ON mig_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_jobs_definition_id ON mig_jobs(definition_id);

CREATE INDEX IF NOT EXISTS idx_mig_jobs_organization_id ON mig_jobs(organization_id);

CREATE INDEX IF NOT EXISTS idx_mig_jobs_project_id ON mig_jobs(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_mappings_tenant_id ON mig_mappings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_object_results_batch_id ON mig_object_results(batch_id);

CREATE INDEX IF NOT EXISTS idx_mig_object_results_tenant_id ON mig_object_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_package_versions_created_by ON mig_package_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_package_versions_tenant_id ON mig_package_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_packages_created_by ON mig_packages(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_packages_organization_id ON mig_packages(organization_id);

CREATE INDEX IF NOT EXISTS idx_mig_packages_tenant_id ON mig_packages(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_packages_updated_by ON mig_packages(updated_by);

CREATE INDEX IF NOT EXISTS idx_mig_plan_steps_package_id ON mig_plan_steps(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_plan_steps_tenant_id ON mig_plan_steps(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_plans_generated_by ON mig_plans(generated_by);

CREATE INDEX IF NOT EXISTS idx_mig_plans_package_id ON mig_plans(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_plans_tenant_id ON mig_plans(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_project_versions_created_by ON mig_project_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_project_versions_tenant_id ON mig_project_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_projects_created_by ON mig_projects(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_projects_organization_id ON mig_projects(organization_id);

CREATE INDEX IF NOT EXISTS idx_mig_projects_owner_user_id ON mig_projects(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_mig_projects_updated_by ON mig_projects(updated_by);

CREATE INDEX IF NOT EXISTS idx_mig_reconciliation_exceptions_job_id ON mig_reconciliation_exceptions(job_id);

CREATE INDEX IF NOT EXISTS idx_mig_reconciliation_exceptions_tenant_id ON mig_reconciliation_exceptions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_reconciliations_tenant_id ON mig_reconciliations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_relationship_mappings_package_id ON mig_relationship_mappings(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_relationship_mappings_project_id ON mig_relationship_mappings(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_relationship_mappings_tenant_id ON mig_relationship_mappings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_retries_error_id ON mig_retries(error_id);

CREATE INDEX IF NOT EXISTS idx_mig_retries_tenant_id ON mig_retries(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_source_configurations_created_by ON mig_source_configurations(created_by);

CREATE INDEX IF NOT EXISTS idx_mig_statistics_package_id ON mig_statistics(package_id);

CREATE INDEX IF NOT EXISTS idx_mig_statistics_project_id ON mig_statistics(project_id);

CREATE INDEX IF NOT EXISTS idx_mig_statistics_tenant_id ON mig_statistics(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_transformations_tenant_id ON mig_transformations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_mig_validation_rules_tenant_id ON mig_validation_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_tenant_id ON notification_deliveries(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_initiator_id ON notification_events(initiator_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_organization_id ON notification_events(organization_id);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant_id ON notification_preferences(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notification_providers_organization_id ON notification_providers(organization_id);

CREATE INDEX IF NOT EXISTS idx_notification_reminders_event_id ON notification_reminders(event_id);

CREATE INDEX IF NOT EXISTS idx_notification_reminders_notification_id ON notification_reminders(notification_id);

CREATE INDEX IF NOT EXISTS idx_notification_reminders_recipient_id ON notification_reminders(recipient_id);

CREATE INDEX IF NOT EXISTS idx_notification_reminders_rule_id ON notification_reminders(rule_id);

CREATE INDEX IF NOT EXISTS idx_notification_reminders_tenant_id ON notification_reminders(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notification_rules_organization_id ON notification_rules(organization_id);

CREATE INDEX IF NOT EXISTS idx_notification_rules_template_id ON notification_rules(template_id);

CREATE INDEX IF NOT EXISTS idx_notification_rules_tenant_id ON notification_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notification_template_versions_changed_by ON notification_template_versions(changed_by);

CREATE INDEX IF NOT EXISTS idx_notification_templates_tenant_id ON notification_templates(tenant_id);

CREATE INDEX IF NOT EXISTS idx_notifications_organization_id ON notifications(organization_id);

CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id);

CREATE INDEX IF NOT EXISTS idx_notifications_template_id ON notifications(template_id);

CREATE INDEX IF NOT EXISTS idx_numbering_allocations_consumed_by ON numbering_allocations(consumed_by);

CREATE INDEX IF NOT EXISTS idx_numbering_allocations_requested_by ON numbering_allocations(requested_by);

CREATE INDEX IF NOT EXISTS idx_numbering_allocations_sequence_id ON numbering_allocations(sequence_id);

CREATE INDEX IF NOT EXISTS idx_numbering_idempotency_allocation_id ON numbering_idempotency(allocation_id);

CREATE INDEX IF NOT EXISTS idx_numbering_object_types_created_by ON numbering_object_types(created_by);

CREATE INDEX IF NOT EXISTS idx_numbering_object_types_tenant_id ON numbering_object_types(tenant_id);

CREATE INDEX IF NOT EXISTS idx_numbering_scheme_versions_created_by ON numbering_scheme_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_numbering_schemes_created_by ON numbering_schemes(created_by);

CREATE INDEX IF NOT EXISTS idx_numbering_schemes_organization_id ON numbering_schemes(organization_id);

CREATE INDEX IF NOT EXISTS idx_numbering_schemes_plant_id ON numbering_schemes(plant_id);

CREATE INDEX IF NOT EXISTS idx_numbering_schemes_site_id ON numbering_schemes(site_id);

CREATE INDEX IF NOT EXISTS idx_numbering_schemes_updated_by ON numbering_schemes(updated_by);

CREATE INDEX IF NOT EXISTS idx_object_approvals_decided_by ON object_approvals(decided_by);

CREATE INDEX IF NOT EXISTS idx_object_approvals_step_id ON object_approvals(step_id);

CREATE INDEX IF NOT EXISTS idx_object_approvals_tenant_id ON object_approvals(tenant_id);

CREATE INDEX IF NOT EXISTS idx_object_checkouts_locked_by ON object_checkouts(locked_by);

CREATE INDEX IF NOT EXISTS idx_object_checkouts_released_by ON object_checkouts(released_by);

CREATE INDEX IF NOT EXISTS idx_object_references_created_by ON object_references(created_by);

CREATE INDEX IF NOT EXISTS idx_object_relationships_created_by ON object_relationships(created_by);

CREATE INDEX IF NOT EXISTS idx_object_releases_from_state_id ON object_releases(from_state_id);

CREATE INDEX IF NOT EXISTS idx_object_releases_lifecycle_version_id ON object_releases(lifecycle_version_id);

CREATE INDEX IF NOT EXISTS idx_object_releases_requested_by ON object_releases(requested_by);

CREATE INDEX IF NOT EXISTS idx_object_releases_rule_id ON object_releases(rule_id);

CREATE INDEX IF NOT EXISTS idx_object_releases_to_state_id ON object_releases(to_state_id);

CREATE INDEX IF NOT EXISTS idx_object_releases_transition_id ON object_releases(transition_id);

CREATE INDEX IF NOT EXISTS idx_object_status_history_actor_id ON object_status_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_object_status_history_tenant_id ON object_status_history(tenant_id);

CREATE INDEX IF NOT EXISTS idx_object_versions_created_by ON object_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_objects_created_by ON objects(created_by);

CREATE INDEX IF NOT EXISTS idx_objects_deleted_by ON objects(deleted_by);

CREATE INDEX IF NOT EXISTS idx_objects_lifecycle_status_id ON objects(lifecycle_status_id);

CREATE INDEX IF NOT EXISTS idx_objects_owner_object_id ON objects(owner_object_id);

CREATE INDEX IF NOT EXISTS idx_objects_updated_by ON objects(updated_by);

CREATE INDEX IF NOT EXISTS idx_observability_alert_events_actor_id ON observability_alert_events(actor_id);

CREATE INDEX IF NOT EXISTS idx_observability_alert_rule_versions_created_by ON observability_alert_rule_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_alert_rules_created_by ON observability_alert_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_acknowledged_by ON observability_alerts(acknowledged_by);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_created_by ON observability_alerts(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_incident_id ON observability_alerts(incident_id);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_resolved_by ON observability_alerts(resolved_by);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_rule_id ON observability_alerts(rule_id);

CREATE INDEX IF NOT EXISTS idx_observability_configuration_updated_by ON observability_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_observability_dashboards_created_by ON observability_dashboards(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_dashboards_organization_id ON observability_dashboards(organization_id);

CREATE INDEX IF NOT EXISTS idx_observability_dashboards_owner_user_id ON observability_dashboards(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_observability_data_assets_created_by ON observability_data_assets(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_data_assets_owner_user_id ON observability_data_assets(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_observability_freshness_definitions_created_by ON observability_freshness_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_health_checks_created_by ON observability_health_checks(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_history_actor_id ON observability_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_observability_incidents_created_by ON observability_incidents(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_incidents_owner_user_id ON observability_incidents(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_observability_jobs_created_by ON observability_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_metric_definitions_created_by ON observability_metric_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_metric_definitions_organization_id ON observability_metric_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_observability_metric_definitions_owner_user_id ON observability_metric_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_observability_metric_observations_metric_id ON observability_metric_observations(metric_id);

CREATE INDEX IF NOT EXISTS idx_observability_metric_versions_created_by ON observability_metric_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_observation_runs_created_by ON observability_observation_runs(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_retention_policies_updated_by ON observability_retention_policies(updated_by);

CREATE INDEX IF NOT EXISTS idx_observability_slo_definitions_created_by ON observability_slo_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_observability_slo_definitions_owner_user_id ON observability_slo_definitions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_observability_thresholds_created_by ON observability_thresholds(created_by);

CREATE INDEX IF NOT EXISTS idx_password_history_user_id ON password_history(user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_pdm_baseline_members_tenant_id ON pdm_baseline_members(tenant_id);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_configuration_rule_id ON pdm_baselines(configuration_rule_id);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_created_by ON pdm_baselines(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_frozen_by ON pdm_baselines(frozen_by);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_organization_id ON pdm_baselines(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_released_by ON pdm_baselines(released_by);

CREATE INDEX IF NOT EXISTS idx_pdm_baselines_revision_rule_id ON pdm_baselines(revision_rule_id);

CREATE INDEX IF NOT EXISTS idx_pdm_cad_associations_created_by ON pdm_cad_associations(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_cad_associations_organization_id ON pdm_cad_associations(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_cad_associations_updated_by ON pdm_cad_associations(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_change_history_actor_user_id ON pdm_change_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_updated_by ON pdm_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_rule_versions_created_by ON pdm_configuration_rule_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_rule_versions_tenant_id ON pdm_configuration_rule_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_rules_created_by ON pdm_configuration_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_rules_organization_id ON pdm_configuration_rules(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_configuration_rules_updated_by ON pdm_configuration_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_datasets_created_by ON pdm_datasets(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_datasets_organization_id ON pdm_datasets(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_datasets_owner_user_id ON pdm_datasets(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_pdm_datasets_updated_by ON pdm_datasets(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_design_data_created_by ON pdm_design_data(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_design_data_organization_id ON pdm_design_data(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_design_data_representation_id ON pdm_design_data(representation_id);

CREATE INDEX IF NOT EXISTS idx_pdm_design_data_updated_by ON pdm_design_data(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_item_revisions_created_by ON pdm_item_revisions(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_item_revisions_organization_id ON pdm_item_revisions(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_item_revisions_owner_user_id ON pdm_item_revisions(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_pdm_item_revisions_updated_by ON pdm_item_revisions(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_items_created_by ON pdm_items(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_items_updated_by ON pdm_items(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_references_organization_id ON pdm_references(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_relationships_created_by ON pdm_relationships(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_relationships_organization_id ON pdm_relationships(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_relationships_updated_by ON pdm_relationships(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_representations_created_by ON pdm_representations(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_representations_organization_id ON pdm_representations(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_representations_updated_by ON pdm_representations(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_revision_rule_versions_created_by ON pdm_revision_rule_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_revision_rule_versions_tenant_id ON pdm_revision_rule_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_pdm_revision_rules_created_by ON pdm_revision_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_revision_rules_organization_id ON pdm_revision_rules(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_revision_rules_updated_by ON pdm_revision_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_issues_tenant_id ON pdm_validation_issues(tenant_id);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_results_actor_user_id ON pdm_validation_results(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_results_dataset_id ON pdm_validation_results(dataset_id);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_results_organization_id ON pdm_validation_results(organization_id);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_results_tenant_id ON pdm_validation_results(tenant_id);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_rules_created_by ON pdm_validation_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_pdm_validation_rules_updated_by ON pdm_validation_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_reference_aliases_created_by ON reference_aliases(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_aliases_tenant_id ON reference_aliases(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_approvals_submitted_by ON reference_approvals(submitted_by);

CREATE INDEX IF NOT EXISTS idx_reference_approvals_tenant_id ON reference_approvals(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_approvals_version_id ON reference_approvals(version_id);

CREATE INDEX IF NOT EXISTS idx_reference_change_requests_approval_id ON reference_change_requests(approval_id);

CREATE INDEX IF NOT EXISTS idx_reference_change_requests_assigned_to ON reference_change_requests(assigned_to);

CREATE INDEX IF NOT EXISTS idx_reference_change_requests_domain_id ON reference_change_requests(domain_id);

CREATE INDEX IF NOT EXISTS idx_reference_change_requests_requested_by ON reference_change_requests(requested_by);

CREATE INDEX IF NOT EXISTS idx_reference_change_requests_tenant_id ON reference_change_requests(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_codes_created_by ON reference_codes(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_codes_replacement_item_id ON reference_codes(replacement_item_id);

CREATE INDEX IF NOT EXISTS idx_reference_codes_tenant_id ON reference_codes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_business_unit_id ON reference_data_items(business_unit_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_company_id ON reference_data_items(company_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_created_by ON reference_data_items(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_organization_id ON reference_data_items(organization_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_owner_user_id ON reference_data_items(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_plant_id ON reference_data_items(plant_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_site_id ON reference_data_items(site_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_steward_user_id ON reference_data_items(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_reference_data_items_updated_by ON reference_data_items(updated_by);

CREATE INDEX IF NOT EXISTS idx_reference_data_versions_created_by ON reference_data_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_domains_created_by ON reference_domains(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_domains_owner_group_id ON reference_domains(owner_group_id);

CREATE INDEX IF NOT EXISTS idx_reference_domains_owner_user_id ON reference_domains(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_reference_domains_steward_group_id ON reference_domains(steward_group_id);

CREATE INDEX IF NOT EXISTS idx_reference_domains_steward_user_id ON reference_domains(steward_user_id);

CREATE INDEX IF NOT EXISTS idx_reference_domains_tenant_id ON reference_domains(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_domains_updated_by ON reference_domains(updated_by);

CREATE INDEX IF NOT EXISTS idx_reference_exports_requested_by ON reference_exports(requested_by);

CREATE INDEX IF NOT EXISTS idx_reference_governance_policies_created_by ON reference_governance_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_hierarchy_created_by ON reference_hierarchy(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_hierarchy_tenant_id ON reference_hierarchy(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_imports_created_by ON reference_imports(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_ownership_history_changed_by ON reference_ownership_history(changed_by);

CREATE INDEX IF NOT EXISTS idx_reference_relationships_created_by ON reference_relationships(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_relationships_target_domain_id ON reference_relationships(target_domain_id);

CREATE INDEX IF NOT EXISTS idx_reference_relationships_tenant_id ON reference_relationships(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reference_scope_policies_created_by ON reference_scope_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_translations_created_by ON reference_translations(created_by);

CREATE INDEX IF NOT EXISTS idx_reference_translations_tenant_id ON reference_translations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_bi_connections_created_by ON reporting_bi_connections(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_bi_datasets_connection_id ON reporting_bi_datasets(connection_id);

CREATE INDEX IF NOT EXISTS idx_reporting_bi_publish_jobs_connection_id ON reporting_bi_publish_jobs(connection_id);

CREATE INDEX IF NOT EXISTS idx_reporting_bi_publish_jobs_dataset_id ON reporting_bi_publish_jobs(dataset_id);

CREATE INDEX IF NOT EXISTS idx_reporting_configuration_updated_by ON reporting_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboard_shares_tenant_id ON reporting_dashboard_shares(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboard_versions_created_by ON reporting_dashboard_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboard_versions_tenant_id ON reporting_dashboard_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboard_widgets_report_id ON reporting_dashboard_widgets(report_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboard_widgets_tenant_id ON reporting_dashboard_widgets(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboards_created_by ON reporting_dashboards(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboards_organization_id ON reporting_dashboards(organization_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboards_owner_user_id ON reporting_dashboards(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboards_published_by ON reporting_dashboards(published_by);

CREATE INDEX IF NOT EXISTS idx_reporting_dashboards_updated_by ON reporting_dashboards(updated_by);

CREATE INDEX IF NOT EXISTS idx_reporting_executions_report_id ON reporting_executions(report_id);

CREATE INDEX IF NOT EXISTS idx_reporting_executions_user_id ON reporting_executions(user_id);

CREATE INDEX IF NOT EXISTS idx_reporting_exports_created_by ON reporting_exports(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_exports_report_id ON reporting_exports(report_id);

CREATE INDEX IF NOT EXISTS idx_reporting_history_actor_id ON reporting_history(actor_id);

CREATE INDEX IF NOT EXISTS idx_reporting_jobs_created_by ON reporting_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_kpi_targets_tenant_id ON reporting_kpi_targets(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_kpi_values_tenant_id ON reporting_kpi_values(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_kpi_versions_created_by ON reporting_kpi_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_kpi_versions_tenant_id ON reporting_kpi_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_kpis_created_by ON reporting_kpis(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_kpis_organization_id ON reporting_kpis(organization_id);

CREATE INDEX IF NOT EXISTS idx_reporting_kpis_owner_user_id ON reporting_kpis(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_reporting_kpis_updated_by ON reporting_kpis(updated_by);

CREATE INDEX IF NOT EXISTS idx_reporting_metric_versions_created_by ON reporting_metric_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_metric_versions_tenant_id ON reporting_metric_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_metrics_created_by ON reporting_metrics(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_metrics_organization_id ON reporting_metrics(organization_id);

CREATE INDEX IF NOT EXISTS idx_reporting_metrics_updated_by ON reporting_metrics(updated_by);

CREATE INDEX IF NOT EXISTS idx_reporting_report_versions_created_by ON reporting_report_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_report_versions_tenant_id ON reporting_report_versions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_reporting_reports_created_by ON reporting_reports(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_reports_organization_id ON reporting_reports(organization_id);

CREATE INDEX IF NOT EXISTS idx_reporting_reports_owner_user_id ON reporting_reports(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_reporting_reports_published_by ON reporting_reports(published_by);

CREATE INDEX IF NOT EXISTS idx_reporting_reports_updated_by ON reporting_reports(updated_by);

CREATE INDEX IF NOT EXISTS idx_reporting_schedules_created_by ON reporting_schedules(created_by);

CREATE INDEX IF NOT EXISTS idx_reporting_schedules_dashboard_id ON reporting_schedules(dashboard_id);

CREATE INDEX IF NOT EXISTS idx_reporting_schedules_kpi_id ON reporting_schedules(kpi_id);

CREATE INDEX IF NOT EXISTS idx_reporting_schedules_report_id ON reporting_schedules(report_id);

CREATE INDEX IF NOT EXISTS idx_roles_parent_id ON roles(parent_id);

CREATE INDEX IF NOT EXISTS idx_search_configuration_updated_by ON search_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_search_exports_file_id ON search_exports(file_id);

CREATE INDEX IF NOT EXISTS idx_search_exports_requested_by ON search_exports(requested_by);

CREATE INDEX IF NOT EXISTS idx_search_history_saved_search_id ON search_history(saved_search_id);

CREATE INDEX IF NOT EXISTS idx_search_history_user_id ON search_history(user_id);

CREATE INDEX IF NOT EXISTS idx_search_index_organization_id ON search_index(organization_id);

CREATE INDEX IF NOT EXISTS idx_search_index_owner_id ON search_index(owner_id);

CREATE INDEX IF NOT EXISTS idx_search_index_site_id ON search_index(site_id);

CREATE INDEX IF NOT EXISTS idx_search_object_types_registered_by ON search_object_types(registered_by);

CREATE INDEX IF NOT EXISTS idx_search_provider_configuration_updated_by ON search_provider_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_search_saved_searches_owner_id ON search_saved_searches(owner_id);

CREATE INDEX IF NOT EXISTS idx_security_classification_rules_created_by ON security_classification_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_security_entitlements_created_by ON security_entitlements(created_by);

CREATE INDEX IF NOT EXISTS idx_security_entitlements_updated_by ON security_entitlements(updated_by);

CREATE INDEX IF NOT EXISTS idx_security_field_rules_created_by ON security_field_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_security_field_rules_updated_by ON security_field_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_security_masking_rules_created_by ON security_masking_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_security_masking_rules_updated_by ON security_masking_rules(updated_by);

CREATE INDEX IF NOT EXISTS idx_security_object_types_created_by ON security_object_types(created_by);

CREATE INDEX IF NOT EXISTS idx_security_organization_rules_created_by ON security_organization_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_security_organization_rules_organization_id ON security_organization_rules(organization_id);

CREATE INDEX IF NOT EXISTS idx_security_plant_rules_created_by ON security_plant_rules(created_by);

CREATE INDEX IF NOT EXISTS idx_security_plant_rules_plant_id ON security_plant_rules(plant_id);

CREATE INDEX IF NOT EXISTS idx_security_policies_created_by ON security_policies(created_by);

CREATE INDEX IF NOT EXISTS idx_security_policies_updated_by ON security_policies(updated_by);

CREATE INDEX IF NOT EXISTS idx_sso_states_provider_id ON sso_states(provider_id);

CREATE INDEX IF NOT EXISTS idx_thread_baselines_created_by ON thread_baselines(created_by);

CREATE INDEX IF NOT EXISTS idx_thread_baselines_organization_id ON thread_baselines(organization_id);

CREATE INDEX IF NOT EXISTS idx_thread_baselines_released_by ON thread_baselines(released_by);

CREATE INDEX IF NOT EXISTS idx_thread_baselines_snapshot_id ON thread_baselines(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_thread_change_history_actor_user_id ON thread_change_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_thread_configuration_updated_by ON thread_configuration(updated_by);

CREATE INDEX IF NOT EXISTS idx_thread_definition_domains_tenant_id ON thread_definition_domains(tenant_id);

CREATE INDEX IF NOT EXISTS idx_thread_definition_relationships_tenant_id ON thread_definition_relationships(tenant_id);

CREATE INDEX IF NOT EXISTS idx_thread_definitions_created_by ON thread_definitions(created_by);

CREATE INDEX IF NOT EXISTS idx_thread_definitions_organization_id ON thread_definitions(organization_id);

CREATE INDEX IF NOT EXISTS idx_thread_definitions_updated_by ON thread_definitions(updated_by);

CREATE INDEX IF NOT EXISTS idx_thread_query_history_actor_user_id ON thread_query_history(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_thread_snapshots_created_by ON thread_snapshots(created_by);

CREATE INDEX IF NOT EXISTS idx_thread_snapshots_organization_id ON thread_snapshots(organization_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);

CREATE INDEX IF NOT EXISTS idx_versioning_configuration_contexts_revision_id ON versioning_configuration_contexts(revision_id);

CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_assignments_version_id ON versioning_effectivity_assignments(version_id);

CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_definitions_configuration_context_id ON versioning_effectivity_definitions(configuration_context_id);

CREATE INDEX IF NOT EXISTS idx_versioning_effectivity_definitions_revision_id ON versioning_effectivity_definitions(revision_id);

CREATE INDEX IF NOT EXISTS idx_versioning_snapshots_parent_snapshot_id ON versioning_snapshots(parent_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_approval_rule_id ON workflow_approvals(approval_rule_id);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_decided_by ON workflow_approvals(decided_by);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_node_id ON workflow_approvals(node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_step_id ON workflow_approvals(step_id);

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_task_id ON workflow_approvals(task_id);

CREATE INDEX IF NOT EXISTS idx_workflow_bindings_definition_id ON workflow_bindings(definition_id);

CREATE INDEX IF NOT EXISTS idx_workflow_bindings_tenant_id ON workflow_bindings(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_bindings_version_id ON workflow_bindings(version_id);

CREATE INDEX IF NOT EXISTS idx_workflow_delegations_from_user_id ON workflow_delegations(from_user_id);

CREATE INDEX IF NOT EXISTS idx_workflow_delegations_tenant_id ON workflow_delegations(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_escalation_rules_notify_user_id ON workflow_escalation_rules(notify_user_id);

CREATE INDEX IF NOT EXISTS idx_workflow_escalation_rules_tenant_id ON workflow_escalation_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_events_actor_id ON workflow_events(actor_id);

CREATE INDEX IF NOT EXISTS idx_workflow_events_task_id ON workflow_events(task_id);

CREATE INDEX IF NOT EXISTS idx_workflow_events_tenant_id ON workflow_events(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instance_nodes_tenant_id ON workflow_instance_nodes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_current_node_id ON workflow_instances(current_node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_organization_id ON workflow_instances(organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_parent_node_id ON workflow_instances(parent_node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_started_by ON workflow_instances(started_by);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_version_id ON workflow_instances(version_id);

CREATE INDEX IF NOT EXISTS idx_workflow_notification_templates_tenant_id ON workflow_notification_templates(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_notifications_task_id ON workflow_notifications(task_id);

CREATE INDEX IF NOT EXISTS idx_workflow_notifications_tenant_id ON workflow_notifications(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_routing_rules_tenant_id ON workflow_routing_rules(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workflow_task_attachments_uploaded_by ON workflow_task_attachments(uploaded_by);

CREATE INDEX IF NOT EXISTS idx_workflow_task_comments_author_id ON workflow_task_comments(author_id);

CREATE INDEX IF NOT EXISTS idx_workflow_task_subtasks_completed_by ON workflow_task_subtasks(completed_by);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_claimed_by ON workflow_tasks(claimed_by);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_completed_by ON workflow_tasks(completed_by);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_created_by ON workflow_tasks(created_by);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_definition_id ON workflow_tasks(definition_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_instance_node_id ON workflow_tasks(instance_node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_node_id ON workflow_tasks(node_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_object_id ON workflow_tasks(object_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_organization_id ON workflow_tasks(organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_parent_task_id ON workflow_tasks(parent_task_id);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_created_by ON workflow_versions(created_by);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_published_by ON workflow_versions(published_by);
