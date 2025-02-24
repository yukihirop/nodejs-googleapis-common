// Copyright 2014-2016, Google, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {GaxiosPromise} from 'gaxios';
import {DefaultTransporter, OAuth2Client} from 'google-auth-library';
import * as qs from 'qs';
import * as stream from 'stream';
import * as urlTemplate from 'url-template';
import * as uuid from 'uuid';
import * as extend from 'extend';

import {APIRequestParams, BodyResponseCallback} from './api';
import {isBrowser} from './isbrowser';
import {SchemaParameters} from './schema';

// tslint:disable-next-line no-var-requires
const pkg = require('../../package.json');

function isReadableStream(obj: stream.Readable | string) {
  return obj instanceof stream.Readable && typeof obj._read === 'function';
}

function getMissingParams(params: SchemaParameters, required: string[]) {
  const missing = new Array<string>();
  required.forEach(param => {
    // Is the required param in the params object?
    if (params[param] === undefined) {
      missing.push(param);
    }
  });

  // If there are any required params missing, return their names in array,
  // otherwise return null
  return missing.length > 0 ? missing : null;
}

/**
 * Create and send request to Google API
 * @param parameters Parameters used to form request
 * @param callback   Callback when request finished or error found
 */
export function createAPIRequest<T>(
  parameters: APIRequestParams
): GaxiosPromise<T>;
export function createAPIRequest<T>(
  parameters: APIRequestParams,
  callback: BodyResponseCallback<T>
): void;
export function createAPIRequest<T>(
  parameters: APIRequestParams,
  callback?: BodyResponseCallback<T>
): void | GaxiosPromise<T> {
  if (callback) {
    createAPIRequestAsync<T>(parameters).then(r => callback(null, r), callback);
  } else {
    return createAPIRequestAsync(parameters);
  }
}

async function createAPIRequestAsync<T>(parameters: APIRequestParams) {
  let params = parameters.params;
  const options = Object.assign({}, parameters.options);

  // Create a new params object so it can no longer be modified from outside
  // code Also support global and per-client params, but allow them to be
  // overriden per-request
  const topOptions =
    parameters.context.google &&
    parameters.context.google._options &&
    parameters.context.google._options.params
      ? parameters.context.google._options.params
      : {};
  params = Object.assign(
    {}, // New base object
    topOptions, // Global params
    parameters.context._options.params, // Per-client params
    params // API call params
  );

  const media = params.media || {};

  /**
   * In a previous version of this API, the request body was stuffed in a field
   * named `resource`.  This caused lots of problems, because it's not uncommon
   * to have an actual named parameter required which is also named `resource`.
   * This mean that users would have to use `resource_` in those cases, which
   * pretty much nobody figures out on their own. The request body is now
   * documented as being in the `requestBody` property, but we also need to keep
   * using `resource` for reasons of back-compat. Cases that need to be covered
   * here:
   * - user provides just a `resource` with a request body
   * - user provides both a `resource` and a `resource_`
   * - user provides just a `requestBody`
   * - user provides both a `requestBody` and a `resource`
   */
  const resource = params.requestBody ? params.requestBody : params.resource;
  if (!params.requestBody && params.resource) {
    delete params.resource;
  }
  delete params.requestBody;

  let authClient =
    params.auth ||
    parameters.context._options.auth ||
    (parameters.context.google
      ? parameters.context.google._options.auth
      : null);

  const defaultMime =
    typeof media.body === 'string' ? 'text/plain' : 'application/octet-stream';
  delete params.media;
  delete params.auth;

  // Grab headers from user provided options
  const headers = params.headers || {};
  delete params.headers;

  // Un-alias parameters that were modified due to conflicts with reserved names
  Object.keys(params).forEach(key => {
    if (key.slice(-1) === '_') {
      const newKey = key.slice(0, -1);
      params[newKey] = params[key];
      delete params[key];
    }
  });

  // Check for missing required parameters in the API request
  const missingParams = getMissingParams(params, parameters.requiredParams);
  if (missingParams) {
    // Some params are missing - stop further operations and inform the
    // developer which required params are not included in the request
    throw new Error('Missing required parameters: ' + missingParams.join(', '));
  }

  // Parse urls
  if (options.url) {
    options.url = urlTemplate.parse(options.url).expand(params);
  }
  if (parameters.mediaUrl) {
    parameters.mediaUrl = urlTemplate.parse(parameters.mediaUrl).expand(params);
  }

  // When forming the querystring, override the serializer so that array
  // values are serialized like this:
  // myParams: ['one', 'two'] ---> 'myParams=one&myParams=two'
  // This serializer also encodes spaces in the querystring as `%20`,
  // whereas the default serializer in gaxios encodes to a `+`.
  options.paramsSerializer = params => {
    return qs.stringify(params, {arrayFormat: 'repeat'});
  };

  // delete path parameters from the params object so they do not end up in
  // query
  parameters.pathParams.forEach(param => {
    delete params[param];
    if (
      parameters.context &&
      parameters.context._options &&
      parameters.context._options.params
    ) {
      delete parameters.context._options.params[param];
    }
  });

  // if authClient is actually a string, use it as an API KEY
  if (typeof authClient === 'string') {
    params.key = params.key || authClient;
    authClient = undefined;
  }

  if (parameters.mediaUrl && media.body) {
    options.url = parameters.mediaUrl;
    if (resource) {
      // gaxios doesn't support multipart/related uploads, so it has to
      // be implemented here.
      params.uploadType = 'multipart';
      const multipart = [
        {'Content-Type': 'application/json', body: JSON.stringify(resource)},
        {
          'Content-Type':
            media.mimeType || (resource && resource.mimeType) || defaultMime,
          body: media.body, // can be a readable stream or raw string!
        },
      ];
      const boundary = uuid.v4();
      const finale = `--${boundary}--`;
      const rStream = new stream.PassThrough({
        flush(callback) {
          this.push('\r\n');
          this.push(finale);
          callback();
        },
      });
      const pStream = new ProgressStream();
      const isStream = isReadableStream(multipart[1].body);
      headers['Content-Type'] = `multipart/related; boundary=${boundary}`;
      for (const part of multipart) {
        const preamble = `--${boundary}\r\nContent-Type: ${part['Content-Type']}\r\n\r\n`;
        rStream.push(preamble);
        if (typeof part.body === 'string') {
          rStream.push(part.body);
          rStream.push('\r\n');
        } else {
          // Gaxios does not natively support onUploadProgress in node.js.
          // Pipe through the pStream first to read the number of bytes read
          // for the purpose of tracking progress.
          pStream.on('progress', bytesRead => {
            if (options.onUploadProgress) {
              options.onUploadProgress({bytesRead});
            }
          });
          part.body.pipe(pStream).pipe(rStream);
        }
      }
      if (!isStream) {
        rStream.push(finale);
        rStream.push(null);
      }
      options.data = rStream;
    } else {
      params.uploadType = 'media';
      Object.assign(headers, {'Content-Type': media.mimeType || defaultMime});
      options.data = media.body;
    }
  } else {
    options.data = resource || undefined;
  }

  options.headers = extend(true, options.headers || {}, headers);
  options.params = params;
  if (!isBrowser()) {
    options.headers!['Accept-Encoding'] = 'gzip';
    const directives = options.userAgentDirectives || [];
    directives.push({
      product: 'google-api-nodejs-client',
      version: pkg.version,
      comment: 'gzip',
    });
    const userAgent = directives
      .map(d => {
        let line = `${d.product}/${d.version}`;
        if (d.comment) {
          line += ` (${d.comment})`;
        }
        return line;
      })
      .join(' ');
    options.headers!['User-Agent'] = userAgent;
  }

  // By default gaxios treats any 2xx as valid, and all non 2xx status
  // codes as errors.  This is a problem for HTTP 304s when used along
  // with an eTag.
  if (!options.validateStatus) {
    options.validateStatus = status => {
      return (status >= 200 && status < 300) || status === 304;
    };
  }

  // Retry by default
  options.retry = options.retry === undefined ? true : options.retry;

  // Combine the GaxiosOptions options passed with this specific
  // API call witht the global options configured at the API Context
  // level, or at the global level.
  const mergedOptions = extend(
    true,
    {},
    parameters.context.google ? parameters.context.google._options : {},
    parameters.context._options,
    options
  );
  delete mergedOptions.auth; // is overridden by our auth code

  // Perform the HTTP request.  NOTE: this function used to return a
  // mikeal/request object. Since the transition to Axios, the method is
  // now void.  This may be a source of confusion for users upgrading from
  // version 24.0 -> 25.0 or up.
  if (authClient && typeof authClient === 'object') {
    return (authClient as OAuth2Client).request<T>(mergedOptions);
  } else {
    return new DefaultTransporter().request<T>(mergedOptions);
  }
}

/**
 * Basic Passthrough Stream that records the number of bytes read
 * every time the cursor is moved.
 */
class ProgressStream extends stream.Transform {
  bytesRead = 0;
  // tslint:disable-next-line: no-any
  _transform(chunk: any, encoding: string, callback: Function) {
    this.bytesRead += chunk.length;
    this.emit('progress', this.bytesRead);
    this.push(chunk);
    callback();
  }
}
