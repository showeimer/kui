/*
 * Copyright 2017-19 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from 'debug'
const debug = Debug('webapp/views/sidecar')
debug('loading')

import * as Marked from 'marked'

import { Sidecar, getSidecar, CustomSpec, CustomContent } from './sidecar-core'
export { Sidecar, getSidecar, CustomSpec, CustomContent }

import presentAs from './sidecar-present'

import { isCustomSpec } from './custom-content'

import { BadgeSpec, Badge, BadgeOptions, getBadgesDomContainer, addBadge, clearBadges, hasBadge } from './badge'
export { BadgeSpec, Badge, BadgeOptions }

import { isPopup } from '../popup-core'
import { Tab, getTabFromTarget } from '../tab'

import { clearSelection, setVisibleClass, setMaximization, enableTabIndex, isFullscreen } from './sidecar-visibility'

import eventBus from '../../core/events'
import { element, removeAllDomChildren } from '../util/dom'
import { prettyPrintTime } from '../util/time'
import { addModeButtons } from '../bottom-stripe'
import { ShowOptions } from './show-options'
import Formattable from './formattable'
import { ToolbarText, ToolbarTextImpl, isToolbarText, isRefreshableToolbarText } from './toolbar-text'
import Presentation from './presentation'
import {
  MetadataBearing,
  isMetadataBearing,
  hasDisplayName,
  MetadataBearingByReference,
  isMetadataBearingByReference,
  Entity
} from '../../models/entity'
import { ExecOptions } from '../../models/execOptions'
import { apply as addRelevantBadges } from './registrar/badges'
import { hasEditor, tryOpenWithEditor } from './registrar/editors'
import { isPromise } from '../../util/types'

/** @deprecated */
export { MetadataBearingByReference }
export { isMetadataBearingByReference }

debug('finished loading modules')

/** cheapo uuid; we only need single-threaded uniqueness */
let _uuidCounter = 1
function uuid() {
  return (_uuidCounter++).toString()
}

export const maybeHideEntity = (tab: Tab, entity: Entity): boolean => {
  const sidecar = getSidecar(tab)

  const entityMatchesSelection =
    sidecar.entity &&
    isMetadataBearing(entity) &&
    isMetadataBearing(sidecar.entity) &&
    sidecar.entity.metadata.name === entity.metadata.name &&
    sidecar.entity.metadata.namespace === entity.metadata.namespace

  debug('maybeHideEntity', entityMatchesSelection, entity, sidecar.entity)
  if (entityMatchesSelection) {
    clearSelection(tab)
    return true
  }
}

/**
 * Return the container of the current active sidecar view
 *
 */
export const getActiveView = (tab: Tab) => {
  const sidecar = getSidecar(tab)
  const activeView = sidecar.getAttribute('data-active-view')
  const container = sidecar.querySelector(`.sidecar-content-container ${activeView}`)

  return container
}

function isHTML(content: CustomContent): content is HTMLElement {
  return typeof content !== 'string' && (content as HTMLElement).nodeName !== undefined
}

/**
 * If the entity has a version attribute, then render it
 *
 */
export const addVersionBadge = (
  tab: Tab,
  entity: MetadataBearing | CustomSpec,
  { clear = false, badgesDom = undefined }: { clear?: boolean; badgesDom?: HTMLElement } = {}
) => {
  if (hasBadge(tab, '.version')) {
    return
  }

  if (clear) {
    clearBadges(tab)
  }

  const version = isMetadataBearing(entity)
    ? entity.metadata.generation
    : isMetadataBearingByReference(entity)
    ? entity.resource.metadata.generation
    : undefined
  if (version) {
    addBadge(tab, /^v/.test(version) ? version : `v${version}`, { badgesDom }).classList.add('version')
  }
}

/**
 * Add view name to the sidecar header "icon text"
 *
 */
export const addSidecarHeaderIconText = (viewName: string, sidecar: HTMLElement) => {
  debug('addSidecarHeaderIconText', viewName)
  const iconDom = element('.sidecar-header-icon', sidecar)

  if (viewName) {
    let iconText = viewName.replace(/s$/, '')

    const A = iconText.split(/(?=[A-Z])/).filter(x => x)
    if (iconText.length > 12 && A.length > 1) {
      iconText = A.map(_ => _.charAt(0)).join('')
    }

    iconDom.innerText = iconText
  } else {
    // no viewName, make sure it appears blank in the UI
    iconDom.innerText = ''
  }
}

/** format the creation time of a resource */
const createdOn = (resource: MetadataBearing, entity: MetadataBearing | CustomSpec): HTMLElement => {
  const startTime = /* resource.status && resource.status.startTime || */ resource.metadata.creationTimestamp
  const prefixText =
    /* resource.status && resource.status.startTime ? 'Started on ' : */ isCustomSpec(entity) && entity.createdOnString
      ? `${entity.createdOnString} `
      : 'Created on '

  if (!startTime) {
    return
  }

  const message = document.createElement('div')
  const datePart = document.createElement('span')

  message.appendChild(document.createTextNode(prefixText))
  message.appendChild(datePart)
  try {
    datePart.appendChild(prettyPrintTime(Date.parse(startTime)))
  } catch (err) {
    debug('error trying to parse this creationTimestamp', resource)
    console.error('error parsing creationTimestamp', err)
    datePart.innerText = resource.metadata.creationTimestamp
  }

  return message
}

/**
 * @return the enclosing tab for the given sidecar
 *
 */
export const getEnclosingTab = (sidecar: Sidecar): Tab => {
  return getTabFromTarget(sidecar)
}

/**
 * Given an entity name and an optional packageName, decorate the sidecar header
 *
 */
export const addNameToSidecarHeader = async (
  sidecar: Sidecar,
  name: string | Element,
  packageName = '',
  onclick?: () => void,
  viewName?: string,
  subtext?: Formattable | ToolbarText,
  entity?: MetadataBearing | MetadataBearingByReference | CustomSpec
) => {
  debug('addNameToSidecarHeader', name, isMetadataBearingByReference(entity), entity)

  // maybe entity.content is a metadat-bearing entity that we can
  // mine for identifying characteristics
  const metadataBearer = isMetadataBearingByReference(entity) ? entity.resource : isMetadataBearing(entity) && entity
  if (metadataBearer) {
    const maybeName =
      name || (hasDisplayName(metadataBearer) && metadataBearer.spec.displayName) || metadataBearer.metadata.name
    if (maybeName) {
      name = maybeName
    }
    if (metadataBearer.metadata.namespace) {
      packageName = metadataBearer.metadata.namespace
    }
    if (metadataBearer.kind) {
      viewName = metadataBearer.kind
    }
  }

  const header = sidecar.querySelector('.sidecar-header')
  const footer = sidecar.querySelector('.sidecar-bottom-stripe')
  const nameDom = header.querySelector('.sidecar-header-name-content')
  nameDom.className = nameDom.getAttribute('data-base-class')

  if (packageName) {
    element('.package-prefix', footer).innerText = packageName
  }

  if (isCustomSpec(entity) && entity.isREPL) {
    header.querySelector('.sidecar-header-text').classList.add('is-repl-like')
  } else {
    header.querySelector('.sidecar-header-text').classList.remove('is-repl-like')
  }

  if (typeof name === 'string') {
    if (isCustomSpec(entity) && entity.isREPL) {
      /* const nameContainer = nameDom.querySelector('.sidecar-header-input') as HTMLInputElement
      nameContainer.value = name
      cli.listen(nameContainer) */
    } else {
      const nameContainer = element('.entity-name', nameDom)
      nameContainer.innerText = name
    }
  } else if (name) {
    const nameContainer = nameDom.querySelector('.entity-name')
    removeAllDomChildren(nameContainer)
    nameContainer.appendChild(name)
  }

  if (onclick) {
    const clickable = element('.entity-name', nameDom)
    clickable.classList.add('clickable')
    clickable.onclick = onclick
  }

  if (isMetadataBearing(entity) && entity.onclick) {
    if (entity.onclick.name) {
      const clickable = element('.entity-name', nameDom)
      clickable.classList.add('clickable')
      clickable.onclick = () => {
        const tab = getEnclosingTab(sidecar)
        tab.REPL.pexec(entity.onclick.name, { tab })
      }
    } else {
      const clickable = element('.entity-name', nameDom)
      clickable.classList.remove('clickable')
      clickable.onclick = undefined
    }
    if (entity.onclick.namespace) {
      const clickable = element('.sidecar-header-icon-wrapper .package-prefix', sidecar)
      clickable.classList.add('clickable')
      clickable.onclick = () => {
        const tab = getEnclosingTab(sidecar)
        tab.REPL.pexec(entity.onclick.namespace, { tab })
      }
    } else {
      const clickable = element('.sidecar-header-icon-wrapper .package-prefix', sidecar)
      clickable.classList.remove('clickable')
      clickable.onclick = undefined
    }
    if (entity.onclick.nameHash) {
      const clickable = element('.entity-name-hash', nameDom)
      clickable.classList.add('clickable')
      clickable.onclick = () => {
        const tab = getEnclosingTab(sidecar)
        tab.REPL.pexec(entity.onclick.nameHash, { tab })
      }
    } else {
      const clickable = element('.entity-name-hash', nameDom)
      clickable.classList.remove('clickable')
      clickable.onclick = undefined
    }
  }

  addSidecarHeaderIconText(viewName, sidecar)

  // if we weren't given a "subtext", and we find legitimate "created
  // on" metadata, then show that as the subtext
  if (!subtext && !entity.toolbarText && metadataBearer) {
    const maybe = createdOn(metadataBearer, isCustomSpec(entity) && entity)
    if (maybe) {
      subtext = maybe
    }
  }

  if (subtext && !isToolbarText(subtext) && (isMetadataBearing(entity) || isCustomSpec(entity)) && entity.toolbarText) {
    // both subtext and toolbarText?
    const subtextContainer = sidecar.querySelector(
      '.sidecar-header-secondary-content .custom-header-content'
    ) as HTMLElement
    removeAllDomChildren(subtextContainer)
    Promise.resolve(subtext).then(subtext => {
      if (typeof subtext === 'string') {
        subtextContainer.innerText = subtext
      } else {
        subtextContainer.appendChild(subtext)
      }
    })
  }

  // handle ToolbarText
  const toolbarTextSpec = isToolbarText(subtext)
    ? subtext
    : (isMetadataBearing(entity) || isCustomSpec(entity)) &&
      (entity.toolbarText || (isMetadataBearingByReference(entity) && entity.resource.toolbarText))
  const toolbarTextContainer = element('.sidecar-bottom-stripe-toolbar .sidecar-toolbar-text', sidecar)
  const toolbarTextContent = element('.sidecar-toolbar-text-content', toolbarTextContainer)
  removeAllDomChildren(toolbarTextContent)
  if (toolbarTextSpec) {
    if (isRefreshableToolbarText(toolbarTextSpec)) {
      toolbarTextSpec.attach(sidecar).refresh()
    } else {
      new ToolbarTextImpl(toolbarTextSpec.type, toolbarTextSpec.text).attach(sidecar).refresh()
    }
  } else if (subtext && !isToolbarText(subtext)) {
    // handle "subtext", which is now treated as a special case of a
    // ToolbarText where the type is 'info'
    const text = await Promise.resolve(subtext)
    toolbarTextContainer.setAttribute('data-type', 'info')
    if (text instanceof Element) {
      toolbarTextContent.appendChild(text)
    } else {
      toolbarTextContent.innerText = text
    }
  } else {
    toolbarTextContent.innerText = ''
    toolbarTextContainer.removeAttribute('data-type')
  }

  return nameDom
}

export const showCustom = async (tab: Tab, custom: CustomSpec, options?: ExecOptions, resultDom?: Element) => {
  if (!custom || custom.content === undefined) return
  debug('showCustom', custom, options, resultDom)

  const sidecar = getSidecar(tab)
  enableTabIndex(sidecar)

  // tell the current view that they're outta here
  if (sidecar.entity || sidecar.uuid) {
    eventBus.emit('/sidecar/replace', sidecar.uuid || sidecar.entity)
  }
  sidecar.uuid = custom.uuid || uuid()

  const hashDom = element('.sidecar-header-name .entity-name-hash', sidecar)
  hashDom.innerText = ''

  // if the view hints that it wants to occupy the full screen and we
  // are not currenlty in fullscreen, OR if the view does not want to
  // occupy full screen and we *are*... in either case (this is an
  // XOR, does as best one can in NodeJS), toggle maximization
  const viewProviderDesiresFullscreen =
    custom.presentation === Presentation.SidecarFullscreen ||
    (isPopup() &&
      (custom.presentation === Presentation.SidecarFullscreenForPopups ||
        custom.presentation === Presentation.FixedSize))

  if (!custom.presentation && !isPopup()) {
    presentAs(tab, Presentation.Default)
  } else if (
    custom.presentation ||
    isPopup() ||
    (viewProviderDesiresFullscreen ? !isFullscreen(tab) : isFullscreen(tab))
  ) {
    const presentation =
      custom.presentation ||
      (viewProviderDesiresFullscreen
        ? Presentation.SidecarFullscreenForPopups
        : custom.presentation !== undefined
        ? custom.presentation
        : Presentation.SidecarFullscreen)
    presentAs(tab, presentation)

    if (viewProviderDesiresFullscreen) {
      setMaximization(tab)
    }
  } else {
    // otherwise, reset to default presentation mode
    presentAs(tab, Presentation.Default)
  }

  if (custom.controlHeaders === true) {
    // plugin will control all headers
  } else if (!custom.controlHeaders) {
    // plugin will control no headers
    const customHeaders = sidecar.querySelectorAll('.custom-header-content')
    for (let idx = 0; idx < customHeaders.length; idx++) {
      removeAllDomChildren(customHeaders[idx])
    }
  } else {
    // plugin will control some headers; it tell us which it wants us to control
    custom.controlHeaders.forEach((_: string) => {
      const customHeaders = sidecar.querySelectorAll(`${_} .custom-header-content`)
      for (let idx = 0; idx < customHeaders.length; idx++) {
        removeAllDomChildren(customHeaders[idx])
      }
    })
  }

  const customContent = sidecar.querySelector('.custom-content')

  if (custom.noZoom) {
    // custom content will control the zoom handler, e.g. monaco-editor
    customContent.classList.remove('zoomable')
  } else {
    // revert the change if previous custom content controls the zoom handler
    customContent.classList.add('zoomable')
  }

  // which viewer is currently active?
  sidecar.setAttribute('data-active-view', '.custom-content > div')

  // add mode buttons, if requested
  const modes = custom.modes
  if (!options || !options.leaveBottomStripeAlone) {
    addModeButtons(tab, modes, custom, options)
    sidecar.setAttribute('class', `${sidecar.getAttribute('data-base-class')} custom-content`)
  } else {
    sidecar.classList.add('custom-content')
  }
  setVisibleClass(sidecar)

  if (custom.sidecarHeader === false) {
    // view doesn't want a sidecar header
    sidecar.classList.add('no-sidecar-header')
  }

  if (custom.displayOptions) {
    custom.displayOptions.forEach(option => {
      sidecar.classList.add(option.replace(/\s/g, '-'))
    })
  }

  const { badgesDom } = getBadgesDomContainer(sidecar)

  let addVersion: () => void
  if (custom && (isMetadataBearing(custom) || isMetadataBearingByReference(custom))) {
    const entity = isMetadataBearingByReference(custom) ? custom.resource : custom
    sidecar.entity = entity
    /* if (sidecar.entity.viewName) {
      sidecar.entity.type = sidecar.entity.viewName
    } */

    const prettyName =
      (isCustomSpec(custom) && custom.prettyName) ||
      (custom.prettyName || entity.prettyName || isMetadataBearingByReference(custom)
        ? custom.resource.prettyName
        : undefined) ||
      entity.metadata.name
    const nameHash = entity.nameHash || custom.nameHash
    hashDom.innerText =
      (nameHash !== undefined
        ? nameHash
        : isMetadataBearingByReference(custom)
        ? custom.resource.nameHash
        : undefined) || ''
    const header = sidecar.querySelector('.sidecar-header')
    const nameDom = header.querySelector('.sidecar-header-name-content')
    if (hashDom.innerText.length > 0) {
      nameDom.setAttribute('data-has-name-hash', 'data-has-name-hash')
    } else {
      nameDom.removeAttribute('data-has-name-hash')
    }

    addNameToSidecarHeader(
      sidecar,
      prettyName,
      undefined,
      undefined,
      entity.kind,
      isCustomSpec(entity) && entity.subtext,
      entity
    )

    // render badges
    clearBadges(tab)
    addVersion = () => addVersionBadge(tab, entity, { badgesDom })

    /* if (custom.duration) {
      const duration = document.createElement('div')
      duration.classList.add('activation-duration')
      duration.innerText = prettyPrintDuration(custom.duration)
      badgesDomContainer.appendChild(duration)
    } */
  }

  // badges
  if (custom && custom.badges) {
    custom.badges.forEach(badge => addBadge(tab, badge, { badgesDom }))
  }
  if (isMetadataBearing(custom) || isMetadataBearingByReference(custom)) {
    const badgeOptions: BadgeOptions = {
      badgesDom: sidecar.querySelector('.sidecar-header .custom-header-content .badges')
    }
    addRelevantBadges(tab, isMetadataBearingByReference(custom) ? custom : { resource: custom }, badgeOptions)
  }

  if (addVersion) addVersion()

  const replView = tab.querySelector('.repl')
  replView.className = `sidecar-visible ${(replView.getAttribute('class') || '').replace(/sidecar-visible/g, '')}`

  const container = resultDom || sidecar.querySelector('.custom-content')
  removeAllDomChildren(container)

  if (isPromise(custom.content)) {
    container.appendChild(await custom.content)
  } else if (custom.contentType) {
    // we were asked ot project out one specific field
    const projection = custom.content

    if (isHTML(projection)) {
      // then its already a DOM
      container.appendChild(projection)
    } else if (custom.contentType === 'text/html') {
      // for html-formatted text, wrap it in a container with padding and scrolling
      if (typeof projection === 'string') {
        const padding = document.createElement('div')
        padding.classList.add('padding-content', 'scrollable', 'page-content')
        const inner = document.createElement('div')
        padding.appendChild(inner)
        inner.innerHTML = projection
        container.appendChild(padding)
      } else {
        debug('WARNING: you said you were giving me html-formatted text, but instead gave me an object')
        container.appendChild(document.createTextNode(JSON.stringify(projection, undefined, 2)))
      }
    } else if (custom.contentType === 'text/markdown') {
      if (typeof projection === 'string') {
        const renderer = new Marked.Renderer()
        const marked = (_: string): string => Marked(_, { renderer })
        renderer.link = (href: string, title: string, text: string) => {
          return `<a class='bx--link' target='_blank' title="${title}" href="${href}">${text}</a>`
        }
        const markdownContainer = document.createElement('div')
        markdownContainer.classList.add('padding-content', 'scrollable', 'marked-content', 'page-content')
        markdownContainer.innerHTML = marked(projection)
        container.appendChild(markdownContainer)
      } else {
        debug('WARNING: you said you were giving me markdown-formatted text, but instead gave me an object')
        container.appendChild(document.createTextNode(JSON.stringify(projection, undefined, 2)))
      }
    } else {
      const tryToUseEditor = hasEditor()
      if (tryToUseEditor) {
        try {
          const { content, presentation } = await tryOpenWithEditor(tab, custom, options)
          customContent.classList.remove('zoomable')
          container.appendChild(content)
          presentAs(tab, Presentation.FixedSize)
          return presentation
        } catch (err) {
          console.error('error loading editor', err)
          // intentional fall-through
        }
      }

      const scrollWrapper = document.createElement('div')
      const pre = document.createElement('pre')
      const code = document.createElement('code')

      container.appendChild(scrollWrapper)
      scrollWrapper.appendChild(pre)
      pre.appendChild(code)

      if (typeof projection === 'string') {
        code.innerText = projection
      } else {
        code.innerText = JSON.stringify(projection, undefined, 2)
      }

      scrollWrapper.style.flex = '1'
      scrollWrapper.classList.add('scrollable')
      scrollWrapper.classList.add('scrollable-auto')

      if (custom.contentType) {
        // caller gave us a content type. attempt to decorate
        const contentType = `language-${custom.contentType}`
        code.classList.add(contentType)
        code.classList.remove('json')
        code.classList.remove(code.getAttribute('data-content-type')) // remove previous
        code.setAttribute('data-content-type', contentType)
      }
    }
  } else if (isHTML(custom.content)) {
    container.appendChild(custom.content)
  } else if (typeof custom.content === 'string') {
    // for plain text, wrap it in a `pre` container with padding and scrolling
    const padding = document.createElement('div')
    padding.classList.add('padding-content', 'scrollable')

    const pre = document.createElement('pre')
    pre.classList.add('pre-wrap', 'sans-serif')
    pre.appendChild(document.createTextNode(custom.content))

    padding.appendChild(pre)
    container.appendChild(padding)
  } else {
    console.error('content type not specified for custom content', custom)
  }
} /* showCustom */

/**
 * Register a renderer for a given <kind>
 *
 */
export type ISidecarViewHandler = (
  tab: Tab,
  entity: Object, // eslint-disable-line @typescript-eslint/ban-types
  sidecar: Element,
  options: ShowOptions
) => void
const registeredEntityViews: Record<string, ISidecarViewHandler> = {}
export const registerEntityView = (kind: string, handler: ISidecarViewHandler) => {
  registeredEntityViews[kind] = handler
}

/**
 * Update the current view into the sidecar; this is helpful for tab
 * mode switching.
 *
 */
export const insertCustomContent = (tab: Tab, view: HTMLElement) => {
  debug('insertCustomContent', view)

  const container = getSidecar(tab).querySelector('.custom-content')
  debug('insertCustomContent.container', container)

  removeAllDomChildren(container)
  container.appendChild(view)

  presentAs(tab, Presentation.Default)
}
