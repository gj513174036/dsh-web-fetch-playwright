/**
 * The Playwright plugin-configuration card: backend radio group — `Local
 * Playwright` (path), `DSH-managed persistent browser` (user-data-dir),
 * `Remote CDP endpoint` (endpoint, shared context), each carrying its own
 * inputs — then the BACKEND-INDEPENDENT controls: headless and extra browser
 * arguments (they apply to every browser this plugin launches, and to the
 * launcher's command for the CDP topology), the outbound-proxy fields (address,
 * bypass list, username, a masked password), the read-only launcher command
 * preview derived from those drafts, the P2 capture controls, the denoise
 * checkbox, and the numeric limits — all staged and saved through the card form
 * like the built-in plugin cards.
 *
 * The proxy fields sit at card level rather than under one backend option: a
 * proxy applies to every browser this plugin launches, and in CDP mode it
 * shapes the launcher's `--proxy-server` flag, so it must stay visible (and
 * resettable) whichever backend runs. The P2 capture fields do too — every
 * backend can record — and they carry the plaintext-credentials warning that
 * belongs next to the switch that produces the dumps.
 *
 * @module dsh-web-fetch-playwright/client/card
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { CheckboxField, CommandPreview, RadioGroupField, ValueField } from './fields.tsx'
import type { PlaywrightCardFace, PlaywrightCardState } from './controller.ts'

/** Props the renderer binds for the Playwright card. */
export type PlaywrightCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'web-fetch-playwright'>
  & InjectFace<PlaywrightCardFace>

/**
 * Render the Playwright card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function PlaywrightCard(props: PlaywrightCardProps) {
  const { t } = props
  const state = props.usePlaywrightCard(snapshot => snapshot)
  const disabled = !state.writable
  // Which backend option's nested fields are live: the draft when it is a
  // known value, else the schema default (local).
  const backend = state.backend.text === 'cdp'
    ? 'cdp'
    : state.backend.text === 'managed' ? 'managed' : 'local'
  // The capture master switch (absent draft = the schema default, off):
  // its detail fields stay disabled until recording is actually on, so the
  // 0700/0600 + plaintext-credentials warning is what the eye lands on first.
  const recording = state.recordNetwork.text === 'true'
  return (
    <PluginCard
      copy={{
        expand: t('expand'),
        collapse: t('collapse'),
        unsaved: t('unsaved'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        discard: t('discard'),
        save: t('save'),
        saving: t('saving'),
      }}
      title={t('title')}
      description={t('description')}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <RadioGroupField
        label={t('backendLabel')}
        options={[
          {
            value: 'local',
            label: t('backendLocal'),
            hint: t('backendLocalHint'),
            content: (
              <ValueField
                embedded
                id="plugin-config-playwright-path"
                label={t('playwrightPath')}
                hint={t('playwrightPathHint')}
                placeholder={t('playwrightPathPlaceholder')}
                overriddenLabel={t('overridden')}
                resetLabel={t('reset')}
                invalidLabel={t('invalidText')}
                disabled={disabled || backend !== 'local'}
                {...state.playwrightPath}
                onEdit={(text) => { props.edit('playwrightPath', text) }}
                onReset={() => { props.resetField('playwrightPath') }}
              />
            ),
          },
          {
            value: 'managed',
            label: t('backendManaged'),
            hint: t('backendManagedHint'),
            content: (
              <ValueField
                embedded
                id="plugin-config-playwright-user-data-dir"
                label={t('userDataDir')}
                hint={t('userDataDirHint')}
                placeholder={t('userDataDirPlaceholder')}
                overriddenLabel={t('overridden')}
                resetLabel={t('reset')}
                invalidLabel={t('invalidText')}
                disabled={disabled || backend !== 'managed'}
                {...state.userDataDir}
                onEdit={(text) => { props.edit('userDataDir', text) }}
                onReset={() => { props.resetField('userDataDir') }}
              />
            ),
          },
          {
            value: 'cdp',
            label: t('backendCdp'),
            hint: t('backendCdpHint'),
            content: (
              <>
                <ValueField
                  embedded
                  id="plugin-config-playwright-cdp"
                  label={t('cdpEndpoint')}
                  hint={t('cdpEndpointHint')}
                  placeholder="127.0.0.1:9222"
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  invalidLabel={t('invalidText')}
                  disabled={disabled || backend !== 'cdp'}
                  {...state.cdpEndpoint}
                  onEdit={(text) => { props.edit('cdpEndpoint', text) }}
                  onReset={() => { props.resetField('cdpEndpoint') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-playwright-share-context"
                  label={t('shareBrowserContext')}
                  hint={t('shareBrowserContextHint')}
                  checked={state.shareBrowserContext.text !== 'false'}
                  overridden={state.shareBrowserContext.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'cdp'}
                  onEdit={(text) => { props.edit('shareBrowserContext', text) }}
                  onReset={() => { props.resetField('shareBrowserContext') }}
                />
              </>
            ),
          },
        ]}
        text={state.backend.text}
        overridden={state.backend.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('backend', text) }}
        onReset={() => { props.resetField('backend') }}
      />
      <CheckboxField
        id="plugin-config-playwright-headless"
        label={t('headless')}
        hint={t('headlessHint')}
        checked={state.headless.text !== 'false'}
        overridden={state.headless.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('headless', text) }}
        onReset={() => { props.resetField('headless') }}
      />
      <ValueField
        id="plugin-config-playwright-launch-args"
        label={t('launchArgs')}
        hint={t('launchArgsHint')}
        placeholder={t('launchArgsPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.launchArgs}
        onEdit={(text) => { props.edit('launchArgs', text) }}
        onReset={() => { props.resetField('launchArgs') }}
      />
      <ValueField
        id="plugin-config-playwright-proxy-server"
        label={t('proxyServer')}
        hint={t('proxyServerHint')}
        placeholder={t('proxyServerPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.proxyServer}
        onEdit={(text) => { props.edit('proxyServer', text) }}
        onReset={() => { props.resetField('proxyServer') }}
      />
      <ValueField
        id="plugin-config-playwright-proxy-bypass"
        label={t('proxyBypass')}
        hint={t('proxyBypassHint')}
        placeholder={t('proxyBypassPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.proxyBypass}
        onEdit={(text) => { props.edit('proxyBypass', text) }}
        onReset={() => { props.resetField('proxyBypass') }}
      />
      <ValueField
        id="plugin-config-playwright-proxy-username"
        label={t('proxyUsername')}
        hint={t('proxyUsernameHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.proxyUsername}
        onEdit={(text) => { props.edit('proxyUsername', text) }}
        onReset={() => { props.resetField('proxyUsername') }}
      />
      <ValueField
        id="plugin-config-playwright-proxy-password"
        secret
        label={t('proxyPassword')}
        hint={t('proxyPasswordHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.proxyPassword}
        onEdit={(text) => { props.edit('proxyPassword', text) }}
        onReset={() => { props.resetField('proxyPassword') }}
      />
      <CommandPreview
        id="plugin-config-playwright-launcher-preview"
        label={t('launcherPreview')}
        hint={t('launcherPreviewHint')}
        command={state.launcherCommand}
      />
      <CheckboxField
        id="plugin-config-playwright-denoise"
        label={t('denoise')}
        hint={t('denoiseHint')}
        checked={state.denoise.text !== 'false'}
        overridden={state.denoise.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('denoise', text) }}
        onReset={() => { props.resetField('denoise') }}
      />
      <CheckboxField
        id="plugin-config-playwright-dismiss-consent"
        label={t('dismissConsent')}
        hint={t('dismissConsentHint')}
        checked={state.dismissConsent.text === 'true'}
        overridden={state.dismissConsent.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('dismissConsent', text) }}
        onReset={() => { props.resetField('dismissConsent') }}
      />
      <ValueField
        id="plugin-config-playwright-concurrency"
        label={t('maxConcurrency')}
        hint={t('maxConcurrencyHint')}
        placeholder={t('maxConcurrencyPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.maxConcurrency}
        onEdit={(text) => { props.edit('maxConcurrency', text) }}
        onReset={() => { props.resetField('maxConcurrency') }}
      />
      <ValueField
        id="plugin-config-playwright-challenge-wait"
        label={t('challengeWaitMs')}
        hint={t('challengeWaitMsHint')}
        placeholder={t('challengeWaitMsPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.challengeWaitMs}
        onEdit={(text) => { props.edit('challengeWaitMs', text) }}
        onReset={() => { props.resetField('challengeWaitMs') }}
      />
      <CheckboxField
        id="plugin-config-playwright-record-network"
        label={t('recordNetwork')}
        hint={state.recordNetwork.text === 'true' ? t('recordWarning') : t('recordNetworkHint')}
        checked={state.recordNetwork.text === 'true'}
        overridden={state.recordNetwork.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('recordNetwork', text) }}
        onReset={() => { props.resetField('recordNetwork') }}
      />
      <ValueField
        id="plugin-config-playwright-record-dir"
        label={t('recordDir')}
        hint={t('recordDirHint')}
        placeholder={t('recordDirPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled || recording === false}
        {...state.recordDir}
        onEdit={(text) => { props.edit('recordDir', text) }}
        onReset={() => { props.resetField('recordDir') }}
      />
      <CheckboxField
        id="plugin-config-playwright-capture-bodies"
        label={t('captureBodies')}
        hint={t('captureBodiesHint')}
        checked={state.captureBodies.text !== 'false'}
        overridden={state.captureBodies.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled || recording === false}
        onEdit={(text) => { props.edit('captureBodies', text) }}
        onReset={() => { props.resetField('captureBodies') }}
      />
      <ValueField
        id="plugin-config-playwright-max-body-bytes"
        label={t('maxBodyBytes')}
        hint={t('maxBodyBytesHint')}
        placeholder={t('maxBodyBytesPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled || recording === false}
        {...state.maxBodyBytes}
        onEdit={(text) => { props.edit('maxBodyBytes', text) }}
        onReset={() => { props.resetField('maxBodyBytes') }}
      />
      <CheckboxField
        id="plugin-config-playwright-record-all-resources"
        label={t('recordAllResources')}
        hint={t('recordAllResourcesHint')}
        checked={state.recordAllResources.text === 'true'}
        overridden={state.recordAllResources.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled || recording === false}
        onEdit={(text) => { props.edit('recordAllResources', text) }}
        onReset={() => { props.resetField('recordAllResources') }}
      />
    </PluginCard>
  )
}
