/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.apache.camel.processor;

import org.apache.camel.ContextTestSupport;
import org.apache.camel.builder.RouteBuilder;
import org.apache.camel.support.processor.PredicateValidationException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

public class SplitMultipleValidateTest extends ContextTestSupport {

    @Test
    public void testMultipleValidateOk() throws Exception {
        getMockEndpoint("mock:split1").expectedMessageCount(1);
        getMockEndpoint("mock:line1").expectedMessageCount(3);
        getMockEndpoint("mock:split2").expectedMessageCount(1);
        getMockEndpoint("mock:line2").expectedMessageCount(3);
        getMockEndpoint("mock:split3").expectedMessageCount(1);
        getMockEndpoint("mock:line3").expectedMessageCount(3);

        template.sendBody("direct:start1", "Hello World");
        template.sendBody("direct:start2", "Hello World");
        template.sendBody("direct:start3", "Hello World");

        assertMockEndpointsSatisfied();
    }

    @Test
    public void testMultipleValidateFail() throws Exception {
        getMockEndpoint("mock:split4").expectedMessageCount(0);
        getMockEndpoint("mock:line4").expectedMessageCount(1);

        try {
            template.sendBody("direct:start4", "Hello World");
            fail();
        } catch (Exception e) {
            PredicateValidationException pve = assertIsInstanceOf(PredicateValidationException.class, e.getCause());
            assertTrue(pve.getMessage().startsWith("Validation failed for Predicate[body > 2]"));
        }

        assertMockEndpointsSatisfied();
    }

    @Override
    protected RouteBuilder createRouteBuilder() {
        return new RouteBuilder() {
            @Override
            public void configure() {
                from("direct:start1")
                .split(constant("123").tokenize(""))
                    .filter(body().isNotNull())
                        .log("Item ${body}")
                        .to("mock:line1")
                    .end() // filter end
                .end() // split end
                .to("mock:split1");

                from("direct:start2")
                    .split(constant("123").tokenize(""))
                        .filter(body().isNotNull())
                            .validate(body().isNotNull())
                            .log("Item ${body}")
                            .to("mock:line2")
                        .end() // filter end
                    .end() // split end
                    .to("mock:split2");

                from("direct:start3")
                    .split(constant("123").tokenize(""))
                        .filter(body().isNotNull())
                            .validate(body().isNotNull())
                            .validate(body().isInstanceOf(String.class))
                            .validate(body().isGreaterThan("0"))
                            .log("Item ${body}")
                            .to("mock:line3")
                        .end() // filter end
                    .end() // split end
                    .to("mock:split3");

                from("direct:start4")
                    .split(constant("123").tokenize(""))
                        .filter(body().isNotNull())
                            .validate(body().isNotNull())
                            .validate(body().isInstanceOf(String.class))
                            .validate(body().isGreaterThan("2"))
                            .log("Item ${body}")
                            .to("mock:line4")
                        .end() // filter end
                    .end() // split end
                    .to("mock:split4");
            }
        };
    }
}
